import {
  type AudioFrame,
  decodeFrame,
  encodeFrame,
  FrameKind,
  parseServerMessage,
  type ServerMessage,
  type SessionConfig,
} from "@fyv/protocol";

export interface RelayClientEvents {
  onMessage(m: ServerMessage): void;
  onAudio(frame: AudioFrame): void;
  onClose(reason: string): void;
}

/** Thin WebSocket client: binary frames out/in, JSON control, clock offset via ping/pong. */
/** Appends the relay token as a query parameter (browsers cannot set headers on WebSocket upgrades). */
export function relayUrlWithToken(url: string, token: string): string {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

export class RelayClient {
  private ws: WebSocket | undefined;
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** relayClock ≈ performance.now() + offsetMs */
  private offsetMs: number | undefined;
  private rttMs = 0;

  constructor(
    private readonly url: string,
    private readonly events: RelayClientEvents,
  ) {}

  async connect(
    config: Partial<SessionConfig> & Pick<SessionConfig, "sourceLang" | "targetLang">,
  ): Promise<void> {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to relay at ${this.url}`));
    });
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      this.stopPings();
      this.events.onClose(ev.reason || `closed (${ev.code})`);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = decodeFrame(ev.data);
        if (frame.kind === FrameKind.TranslatedAudio) this.events.onAudio(frame);
        return;
      }
      const m = parseServerMessage(String(ev.data));
      if (m.type === "pong") {
        const now = performance.now();
        this.rttMs = now - m.tsMs;
        this.offsetMs = m.serverTsMs - (m.tsMs + this.rttMs / 2);
        return;
      }
      if (m.type === "session.ready") this.startPings();
      this.events.onMessage(m);
    };
    this.sendJson({ type: "session.start", config });
  }

  sendAudio(pcm: Int16Array, tsMs: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      encodeFrame({
        kind: FrameKind.CaptureAudio,
        flags: 0,
        seq: this.seq++,
        tsMs: Math.round(tsMs),
        segmentId: 0,
        pcm,
      }),
    );
  }

  speechEnd(): void {
    this.sendJson({ type: "speech.end", tsMs: performance.now() });
  }

  /** Report playback start in client time; converted to relay time when the clock offset is known. */
  reportPlayback(segmentId: number, playbackStartPerfMs: number, backlogMs: number): void {
    if (this.offsetMs === undefined) return;
    this.sendJson({
      type: "trace.playback",
      segmentId,
      playbackStartTsMs: Math.max(0, playbackStartPerfMs + this.offsetMs),
      backlogMs,
    });
  }

  get rtt(): number {
    return this.rttMs;
  }

  close(): void {
    this.stopPings();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({ type: "session.stop" });
      this.ws.close(1000, "client stop");
    }
    this.ws = undefined;
  }

  private startPings(): void {
    this.stopPings();
    this.sendJson({ type: "ping", tsMs: performance.now() });
    this.pingTimer = setInterval(
      () => this.sendJson({ type: "ping", tsMs: performance.now() }),
      2000,
    );
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private sendJson(m: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}
