import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Providers } from "@parley/core";
import { TranslationSession } from "@parley/core";
import {
  type ClientMessage,
  decodeFrame,
  encodeFrame,
  FrameKind,
  parseClientMessage,
  type ServerMessage,
} from "@parley/protocol";
import { type WebSocket, WebSocketServer } from "ws";

export interface RelayOptions {
  providers: () => Providers;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Max concurrent sessions; protects provider quotas during the beta. */
  maxSessions?: number;
}

/** One WebSocket = one translation session. JSON text frames are control, binary frames are PCM16. */
export class RelayServer {
  readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, TranslationSession>();
  private readonly log: NonNullable<RelayOptions["log"]>;

  constructor(private readonly opts: RelayOptions) {
    this.log = opts.log ?? (() => {});
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
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
    this.log("ws.open", { connId, ip: req.socket.remoteAddress });
    let seq = 0;
    const send = (m: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const session = this.sessions.get(ws);
      if (isBinary) {
        if (!session) return;
        try {
          const frame = decodeFrame(toUint8(data));
          if (frame.kind === FrameKind.CaptureAudio) session.pushAudio(frame.pcm);
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
          this.log("session.start", { connId, ...msg.config });
          s.start().catch((err) => {
            this.log("session.start.failed", { connId, err: String(err) });
            this.sessions.delete(ws);
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
      void this.stopSession(ws, "disconnect");
    });
    ws.on("error", (err) => this.log("ws.error", { connId, err: String(err) }));
  }

  private async stopSession(ws: WebSocket, reason: string): Promise<void> {
    const s = this.sessions.get(ws);
    if (!s) return;
    this.sessions.delete(ws);
    await s.stop(reason);
    this.log("session.stop", { reason, traces: s.tracer.all().length });
  }
}

function toUint8(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
