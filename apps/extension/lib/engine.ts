import {
  type CaptureWorkletMessage,
  Ducker,
  int16ToFloat,
  type PlaybackWorkletCommand,
  type PlaybackWorkletMessage,
  Resampler,
} from "@nyv/audio";
import type { AudioFrame, ServerMessage } from "@nyv/protocol";
import { type Caption, IDLE_STATUS, type Settings, type Status } from "./messages.js";
import { RelayClient, relayUrlWithToken } from "./relay-client.js";

export interface EngineEvents {
  onStatus(status: Status): void;
  onCaption(caption: Caption): void;
}

/**
 * Runs inside the offscreen document: tab audio → capture worklet → relay; relay → playback worklet → speakers.
 * The original tab audio is passed through a GainNode so the listener still hears it, ducked while we speak.
 */
export class Engine {
  private ctx: AudioContext | undefined;
  private stream: MediaStream | undefined;
  private relay: RelayClient | undefined;
  private playback: AudioWorkletNode | undefined;
  private duckGain: GainNode | undefined;
  private readonly ducker = new Ducker();
  private outResampler: Resampler | undefined;
  private status: Status = { ...IDLE_STATUS };
  private readonly captions = new Map<number, Caption>();
  private latencies: number[] = [];
  /** Segments already counted toward the latency readout (the relay re-sends trace on each hop). */
  private readonly traced = new Set<number>();
  private duckTimer: ReturnType<typeof setInterval> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly events: EngineEvents) {}

  async start(streamId: string, settings: Settings): Promise<void> {
    await this.stop();
    this.setStatus({ ...IDLE_STATUS, state: "connecting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Chrome-specific constraints for tab capture.
          mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
        } as MediaTrackConstraints,
        video: false,
      });
      this.stream = stream;
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      await Promise.all([
        ctx.audioWorklet.addModule(chrome.runtime.getURL("/worklets/capture.worklet.js")),
        ctx.audioWorklet.addModule(chrome.runtime.getURL("/worklets/playback.worklet.js")),
      ]);

      const source = ctx.createMediaStreamSource(stream);
      this.duckGain = ctx.createGain();
      source.connect(this.duckGain).connect(ctx.destination);

      const capture = new AudioWorkletNode(ctx, "nyv-capture", { numberOfOutputs: 0 });
      source.connect(capture);
      capture.port.onmessage = (e: MessageEvent<CaptureWorkletMessage>) => this.onCapture(e.data);

      this.playback = new AudioWorkletNode(ctx, "nyv-playback", {
        numberOfInputs: 0,
        outputChannelCount: [1],
      });
      this.playback.connect(ctx.destination);
      this.playback.port.onmessage = (e: MessageEvent<PlaybackWorkletMessage>) =>
        this.onPlayback(e.data);

      this.relay = new RelayClient(relayUrlWithToken(settings.relayUrl, settings.relayToken), {
        onMessage: (m) => this.onRelayMessage(m),
        onAudio: (f) => this.onRelayAudio(f),
        onClose: (reason) => {
          if (this.status.state === "active" || this.status.state === "connecting") {
            this.setStatus({
              ...this.status,
              state: "error",
              error: `relay disconnected: ${reason}`,
            });
          }
        },
      });
      await this.relay.connect({
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
      });
      this.duckTimer = setInterval(() => this.applyDucking(), 50);
    } catch (err) {
      await this.stop();
      this.setStatus({
        ...IDLE_STATUS,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.duckTimer) clearInterval(this.duckTimer);
    this.duckTimer = undefined;
    this.relay?.close();
    this.relay = undefined;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    this.playback = undefined;
    this.duckGain = undefined;
    this.outResampler = undefined;
    this.captions.clear();
    this.latencies = [];
    this.traced.clear();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = undefined;
      await ctx.close().catch(() => {});
    }
    if (this.status.state !== "idle") this.setStatus({ ...IDLE_STATUS });
  }

  getStatus(): Status {
    return this.status;
  }

  private onCapture(m: CaptureWorkletMessage): void {
    if (m.type === "pcm") {
      this.relay?.sendAudio(m.pcm, performance.now());
      this.status.level = m.level;
      return;
    }
    if (m.event === "speechEnd") this.relay?.speechEnd();
  }

  private onRelayMessage(m: ServerMessage): void {
    switch (m.type) {
      case "session.ready":
        this.outResampler = new Resampler(m.outputSampleRate, this.ctx?.sampleRate ?? 48000);
        {
          const { error: _dropped, ...rest } = this.status;
          this.setStatus({ ...rest, state: "active", providers: m.providers });
        }
        break;
      case "transcript": {
        const c = this.captions.get(m.segmentId) ?? {
          segmentId: m.segmentId,
          source: "",
          target: "",
          final: false,
        };
        c.source = m.text;
        this.captions.set(m.segmentId, c);
        this.events.onCaption({ ...c });
        break;
      }
      case "translation": {
        const c = this.captions.get(m.segmentId) ?? {
          segmentId: m.segmentId,
          source: "",
          target: "",
          final: false,
        };
        c.target = m.text;
        c.final = m.final;
        this.captions.set(m.segmentId, c);
        this.events.onCaption({ ...c });
        if (m.final) this.captions.delete(m.segmentId);
        break;
      }
      case "trace":
        if (
          m.hops.playbackStart !== undefined &&
          m.hops.speechEnd !== undefined &&
          !this.traced.has(m.segmentId)
        ) {
          this.traced.add(m.segmentId);
          const e2e = m.hops.playbackStart - m.hops.speechEnd;
          this.latencies.push(e2e);
          if (this.latencies.length > 50) this.latencies.shift();
          const sorted = [...this.latencies].sort((a, b) => a - b);
          const p50 = sorted[Math.floor((sorted.length - 1) / 2)] ?? e2e;
          this.setStatus({ ...this.status, latency: { last: e2e, p50, n: this.latencies.length } });
        }
        break;
      case "error":
        if (m.fatal) this.setStatus({ ...this.status, state: "error", error: m.message });
        else console.warn("[nyv] relay:", m.code, m.message);
        break;
      case "session.stopped":
        if (this.status.state === "active") void this.stop();
        break;
      default:
        break;
    }
  }

  private onRelayAudio(f: AudioFrame): void {
    if (!this.playback || !this.outResampler) return;
    if (f.pcm.length === 0) {
      this.post({ type: "segmentEnd", segmentId: f.segmentId });
      return;
    }
    const pcm = this.outResampler.process(int16ToFloat(f.pcm));
    this.post({ type: "push", segmentId: f.segmentId, pcm });
  }

  private onPlayback(m: PlaybackWorkletMessage): void {
    if (m.type === "segmentStart") {
      const ctx = this.ctx;
      if (!ctx) return;
      // Map context time to performance.now(); output latency is when the sample actually leaves the device.
      const perfMs =
        performance.now() + (m.contextTime - ctx.currentTime + (ctx.outputLatency || 0)) * 1000;
      this.relay?.reportPlayback(m.segmentId, perfMs, this.status.backlogMs);
      return;
    }
    if (m.playing) this.ducker.active(performance.now());
    this.status.backlogMs = m.backlogMs;
    this.status.rate = m.rate;
    this.scheduleStatus();
  }

  private applyDucking(): void {
    if (!this.duckGain || !this.ctx) return;
    const { gain, rampMs } = this.ducker.target(performance.now());
    const ducking = gain < 1;
    if (ducking !== this.status.ducking) {
      this.status.ducking = ducking;
      this.scheduleStatus();
    }
    const now = this.ctx.currentTime;
    this.duckGain.gain.cancelScheduledValues(now);
    this.duckGain.gain.setTargetAtTime(gain, now, rampMs / 1000 / 3);
  }

  private post(cmd: PlaybackWorkletCommand): void {
    this.playback?.port.postMessage(cmd, cmd.type === "push" ? [cmd.pcm.buffer] : []);
  }

  private setStatus(s: Status): void {
    this.status = s;
    this.events.onStatus(s);
  }

  /** Coalesce high-frequency worklet status into ~5 Hz UI updates. */
  private scheduleStatus(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.events.onStatus(this.status);
    }, 200);
  }
}
