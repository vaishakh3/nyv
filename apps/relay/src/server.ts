import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Providers } from "@nyv/core";
import { TranslationSession } from "@nyv/core";
import {
  type ClientMessage,
  decodeFrame,
  encodeFrame,
  FrameKind,
  parseClientMessage,
  type ServerMessage,
} from "@nyv/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { Metrics } from "./metrics.js";

export interface RelayOptions {
  providers: () => Providers;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Max concurrent sessions; protects provider quotas during the beta. */
  maxSessions?: number;
  /** Max concurrent sessions from one client IP (0 = unlimited). */
  maxSessionsPerIp?: number;
  /** Hard cap on a session's lifetime (0 = unlimited). */
  maxSessionMs?: number;
  /** Stop a session that has received no audio for this long (0 = never). */
  idleMs?: number;
  /** Return false to refuse the upgrade with 401 (token / origin checks live in main.ts). */
  authorize?: (req: IncomingMessage) => boolean;
  /** Use X-Forwarded-For for the client IP (behind a trusted proxy / load balancer). */
  trustProxy?: boolean;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** One WebSocket = one translation session. JSON text frames are control, binary frames are PCM16. */
export class RelayServer {
  readonly wss: WebSocketServer;
  readonly metrics = new Metrics();
  private readonly sessions = new Map<WebSocket, TranslationSession>();
  private readonly perIp = new Map<string, number>();
  private readonly ipOf = new Map<WebSocket, string>();
  private readonly log: NonNullable<RelayOptions["log"]>;

  constructor(private readonly opts: RelayOptions) {
    this.log = opts.log ?? (() => {});
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    if (this.opts.authorize && !this.opts.authorize(req)) {
      this.metrics.reject("unauthorized");
      this.log("ws.unauthorized", { ip: clientIp(req, this.opts.trustProxy ?? false) });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop("server_shutdown")));
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = randomUUID().slice(0, 8);
    const ip = clientIp(req, this.opts.trustProxy ?? false);
    this.log("ws.open", { connId, ip });
    let seq = 0;
    let lastAudioAt = Date.now();
    const observed = new Set<number>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const send = (m: ServerMessage) => {
      if (m.type === "trace" && m.hops.playbackStart !== undefined && !observed.has(m.segmentId)) {
        observed.add(m.segmentId);
        this.metrics.observe(m.hops);
      }
      if (m.type === "error") this.metrics.errorsTotal++;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const endWith = (code: "session_expired" | "idle", message: string) => {
      send({ type: "error", code, message, fatal: true });
      void this.stopSession(ws, code).then(() => ws.close(1000, code));
    };

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const session = this.sessions.get(ws);
      if (isBinary) {
        if (!session) return;
        try {
          const frame = decodeFrame(toUint8(data));
          if (frame.kind === FrameKind.CaptureAudio) {
            lastAudioAt = Date.now();
            session.pushAudio(frame.pcm);
          }
        } catch (err) {
          send({ type: "error", code: "bad_frame", message: String(err), fatal: false });
        }
        return;
      }
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(toUint8(data).toString());
      } catch (err) {
        send({ type: "error", code: "bad_message", message: String(err), fatal: false });
        return;
      }
      switch (msg.type) {
        case "session.start": {
          if (session) {
            send({
              type: "error",
              code: "already_started",
              message: "session already started",
              fatal: false,
            });
            return;
          }
          if (this.opts.maxSessions && this.sessions.size >= this.opts.maxSessions) {
            send({
              type: "error",
              code: "capacity",
              message: "relay at capacity, try again shortly",
              fatal: true,
            });
            ws.close(1013, "capacity");
            this.metrics.reject("capacity");
            return;
          }
          const perIp = this.opts.maxSessionsPerIp ?? 0;
          if (perIp > 0 && (this.perIp.get(ip) ?? 0) >= perIp) {
            send({
              type: "error",
              code: "too_many_sessions",
              message: `at most ${perIp} concurrent sessions per client`,
              fatal: true,
            });
            ws.close(1008, "too_many_sessions");
            this.metrics.reject("per_ip");
            return;
          }
          const s = new TranslationSession(
            { sessionId: connId, config: msg.config, providers: this.opts.providers() },
            {
              onMessage: send,
              onAudio: (segmentId, pcm, last) => {
                if (ws.readyState !== ws.OPEN) return;
                ws.send(
                  encodeFrame({
                    kind: FrameKind.TranslatedAudio,
                    flags: last ? 1 : 0,
                    seq: seq++,
                    tsMs: Math.round(s.clock.now()),
                    segmentId,
                    pcm,
                  }),
                );
              },
            },
          );
          this.sessions.set(ws, s);
          this.ipOf.set(ws, ip);
          this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
          this.metrics.sessionsActive++;
          this.metrics.sessionsTotal++;
          this.log("session.start", { connId, ip, ...msg.config });
          if (this.opts.maxSessionMs)
            timers.push(
              setTimeout(
                () => endWith("session_expired", "maximum session length reached"),
                this.opts.maxSessionMs,
              ),
            );
          if (this.opts.idleMs) {
            const idle = this.opts.idleMs;
            const t = setInterval(
              () => {
                if (Date.now() - lastAudioAt > idle) endWith("idle", "no audio received; stopping");
              },
              Math.min(idle, 30_000),
            );
            timers.push(t as unknown as ReturnType<typeof setTimeout>);
          }
          s.start().catch((err) => {
            this.log("session.start.failed", { connId, err: String(err) });
            void this.stopSession(ws, "start_failed");
          });
          return;
        }
        case "session.stop":
          void this.stopSession(ws, "client");
          return;
        case "speech.end":
          session?.speechEnded();
          return;
        case "trace.playback":
          session?.reportPlayback(msg.segmentId, msg.playbackStartTsMs);
          return;
        case "ping":
          send({
            type: "pong",
            tsMs: msg.tsMs,
            serverTsMs: session ? session.clock.now() : performance.now(),
          });
          return;
      }
    });
    ws.on("close", () => {
      this.log("ws.close", { connId });
      for (const t of timers) clearTimeout(t);
      void this.stopSession(ws, "disconnect");
    });
    ws.on("error", (err) => this.log("ws.error", { connId, err: String(err) }));
  }

  private async stopSession(ws: WebSocket, reason: string): Promise<void> {
    const s = this.sessions.get(ws);
    if (!s) return;
    this.sessions.delete(ws);
    const ip = this.ipOf.get(ws);
    if (ip !== undefined) {
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
      this.ipOf.delete(ws);
    }
    this.metrics.sessionsActive--;
    await s.stop(reason);
    const traces = s.tracer.all();
    const e2e = traces
      .map(({ hops: h }) => (h.playbackStart ?? Number.NaN) - (h.speechEnd ?? Number.NaN))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    this.log("session.stop", {
      sessionId: s.id,
      reason,
      segments: traces.length,
      ...(e2e.length ? { p50Ms: Math.round(e2e[Math.floor(e2e.length / 2)] as number) } : {}),
    });
  }
}

function toUint8(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
