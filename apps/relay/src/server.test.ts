import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeFrame,
  encodeFrame,
  FrameKind,
  parseServerMessage,
  type ServerMessage,
} from "@fyv/protocol";
import { MockAsrProvider, MockMtProvider, MockTtsProvider } from "@fyv/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Metrics } from "./metrics.js";
import { Quota } from "./quota.js";
import { RelayServer } from "./server.js";

let url = "";
let relay: RelayServer;
const http = createServer();

beforeAll(async () => {
  relay = new RelayServer({
    providers: () => ({
      asr: new MockAsrProvider({
        script: [{ atMs: 400, text: "Hello there.", speechFinal: true }],
        latencyMs: 5,
      }),
      mt: new MockMtProvider({ firstTokenMs: 5, msPerToken: 1 }),
      tts: new MockTtsProvider({ firstByteMs: 5, msPerChar: 2, chunkMs: 20, sampleRate: 8000 }),
    }),
  });
  http.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => http.listen(0, r));
  url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/v1/session`;
});
afterAll(async () => {
  await relay.close();
  http.close();
});

describe("RelayServer", () => {
  it("runs a session end to end over the wire", async () => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const messages: ServerMessage[] = [];
    const frames: { segmentId: number; samples: number; last: boolean }[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on("message", (data: ArrayBuffer | string, isBinary) => {
        if (isBinary) {
          const f = decodeFrame(data as ArrayBuffer);
          frames.push({ segmentId: f.segmentId, samples: f.pcm.length, last: (f.flags & 1) === 1 });
          return;
        }
        const m = parseServerMessage(data.toString());
        messages.push(m);
        if (m.type === "segment.audio.end")
          ws.send(
            JSON.stringify({
              type: "trace.playback",
              segmentId: m.segmentId,
              playbackStartTsMs: 1234,
              backlogMs: 0,
            }),
          );
        if (m.type === "trace" && m.hops.playbackStart)
          ws.send(JSON.stringify({ type: "session.stop" }));
        if (m.type === "session.stopped") resolve();
      });
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(
      JSON.stringify({ type: "session.start", config: { sourceLang: "en", targetLang: "hi" } }),
    );
    ws.send(JSON.stringify({ type: "ping", tsMs: 1 }));
    for (let i = 0; i < 25; i++) {
      ws.send(
        encodeFrame({
          kind: FrameKind.CaptureAudio,
          flags: 0,
          seq: i,
          tsMs: i * 20,
          segmentId: 0,
          pcm: new Int16Array(320),
        }),
      );
    }
    await done;
    ws.close();

    expect(messages.find((m) => m.type === "session.ready")).toMatchObject({
      outputSampleRate: 8000,
    });
    expect(messages.find((m) => m.type === "pong")).toMatchObject({ tsMs: 1 });
    expect(messages.find((m) => m.type === "translation" && m.final)).toMatchObject({
      segmentId: 1,
      text: "Hello there.",
    });
    expect(frames.at(-1)).toMatchObject({ segmentId: 1, last: true, samples: 0 });
    expect(frames.filter((f) => !f.last).reduce((a, f) => a + f.samples, 0)).toBe(8000 * 0.024);
    expect(messages.at(-1)).toMatchObject({ type: "session.stopped", reason: "client" });
  });

  it("rejects garbage without dropping the connection", async () => {
    const ws = new WebSocket(url);
    await new Promise((r) => ws.on("open", r));
    const first = new Promise<ServerMessage>((resolve) =>
      ws.once("message", (d) => resolve(parseServerMessage(d.toString()))),
    );
    ws.send("not json");
    expect(await first).toMatchObject({ type: "error", code: "bad_message", fatal: false });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

function mockProviders() {
  return {
    asr: new MockAsrProvider({ script: [], latencyMs: 5 }),
    mt: new MockMtProvider({ firstTokenMs: 5, msPerToken: 1 }),
    tts: new MockTtsProvider({ firstByteMs: 5, msPerChar: 2, chunkMs: 20, sampleRate: 8000 }),
  };
}

async function listen(relay: RelayServer) {
  const server = createServer();
  server.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, r));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/session`,
    close: async () => {
      await relay.close();
      server.close();
    },
  };
}

const startMsg = JSON.stringify({
  type: "session.start",
  config: { sourceLang: "en", targetLang: "hi", direction: "inbound", inputSampleRate: 16000 },
});

function firstMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) =>
    ws.once("message", (d: ArrayBuffer | string) => resolve(parseServerMessage(d.toString()))),
  );
}

describe("RelayServer hardening", () => {
  it("refuses the upgrade with 401 when authorize() says no", async () => {
    const r = new RelayServer({
      providers: mockProviders,
      authorize: (req) =>
        new URL(req.url ?? "/", "http://x").searchParams.get("token") === "s3cret",
    });
    const { url, close } = await listen(r);
    const denied = new WebSocket(url);
    const err = await new Promise<Error>((resolve) => denied.once("error", resolve));
    expect(err.message).toMatch(/401/);
    expect(r.metrics.rejected.get("unauthorized")).toBe(1);

    const ok = new WebSocket(`${url}?token=s3cret`);
    await new Promise<void>((resolve) => ok.once("open", () => resolve()));
    ok.send(startMsg);
    const first = await firstMessage(ok);
    expect(first.type).toBe("session.ready");
    ok.close();
    await close();
  });

  it("caps concurrent sessions per client IP", async () => {
    const r = new RelayServer({ providers: mockProviders, maxSessionsPerIp: 1 });
    const { url, close } = await listen(r);
    const a = new WebSocket(url);
    await new Promise<void>((resolve) => a.once("open", () => resolve()));
    a.send(startMsg);
    expect((await firstMessage(a)).type).toBe("session.ready");

    const b = new WebSocket(url);
    await new Promise<void>((resolve) => b.once("open", () => resolve()));
    b.send(startMsg);
    const m = await firstMessage(b);
    expect(m.type === "error" && m.code).toBe("too_many_sessions");
    expect(r.metrics.sessionsActive).toBe(1);

    a.close();
    await new Promise((res) => setTimeout(res, 50));
    expect(r.metrics.sessionsActive).toBe(0);
    const c = new WebSocket(url);
    await new Promise<void>((resolve) => c.once("open", () => resolve()));
    c.send(startMsg);
    expect((await firstMessage(c)).type).toBe("session.ready");
    c.close();
    await close();
  });

  it("ends a session that exceeds its maximum length", async () => {
    const r = new RelayServer({ providers: mockProviders, maxSessionMs: 50 });
    const { url, close } = await listen(r);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(startMsg);
    const codes: string[] = [];
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    ws.on("message", (d: ArrayBuffer | string) => {
      const m = parseServerMessage(d.toString());
      if (m.type === "error") codes.push(m.code);
    });
    expect(await closed).toBe(1000);
    expect(codes).toContain("session_expired");
    await close();
  });
});

describe("Metrics", () => {
  it("renders counters and latency quantiles in Prometheus text format", () => {
    const m = new Metrics();
    m.sessionsTotal = 2;
    m.reject("unauthorized");
    for (const v of [900, 1000, 1100, 2000]) m.observe({ speechEnd: 0, playbackStart: v });
    const text = m.render();
    expect(text).toContain("fyv_sessions_total 2");
    expect(text).toContain('fyv_rejected_total{reason="unauthorized"} 1');
    expect(text).toContain('fyv_perceived_latency_ms{quantile="0.5"} 1100');
    expect(text).toContain("fyv_perceived_latency_ms_count 4");
  });
});

describe("RelayServer quota", () => {
  it("ends a session when the daily budget runs out and refuses the next one", async () => {
    const quota = new Quota(50);
    const srv = createServer();
    const r = new RelayServer({
      providers: () => ({
        asr: new MockAsrProvider({ script: [], latencyMs: 5 }),
        mt: new MockMtProvider({ firstTokenMs: 5, msPerToken: 1 }),
        tts: new MockTtsProvider({ firstByteMs: 5, msPerChar: 2, chunkMs: 20, sampleRate: 8000 }),
      }),
      identify: () => "code-1",
      quota,
    });
    srv.on("upgrade", (req, socket, head) => r.handleUpgrade(req, socket, head));
    await new Promise<void>((ok) => srv.listen(0, ok));
    const u = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/session`;
    const firstError = async () => {
      const ws = new WebSocket(u);
      const m = await new Promise<ServerMessage>((resolve) => {
        ws.on("message", (data) => {
          const msg = parseServerMessage(data.toString());
          if (msg.type === "error") resolve(msg);
        });
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "session.start",
              config: { sourceLang: "en", targetLang: "hi" },
            }),
          ),
        );
      });
      await new Promise<void>((resolve) =>
        ws.readyState === ws.CLOSED ? resolve() : ws.on("close", () => resolve()),
      );
      return m;
    };
    const a = await firstError();
    expect(a.type === "error" && a.code).toBe("quota_exceeded");
    expect(quota.remainingMs("code-1")).toBe(0);
    const b = await firstError();
    expect(b.type === "error" && b.code).toBe("quota_exceeded");
    expect(r.metrics.rejected.get("quota")).toBe(1);
    await r.close();
    srv.close();
  });
});
