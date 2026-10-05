import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeFrame,
  encodeFrame,
  FrameKind,
  parseServerMessage,
  type ServerMessage,
} from "@nyv/protocol";
import { MockAsrProvider, MockMtProvider, MockTtsProvider } from "@nyv/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
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
