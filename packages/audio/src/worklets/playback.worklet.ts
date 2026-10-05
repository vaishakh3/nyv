import { catchUpRate, DEFAULT_CATCH_UP, RateSmoother } from "../catch-up.js";
import { RingBuffer } from "../ring-buffer.js";
import { TimeStretcher } from "../time-stretch.js";
import type { PlaybackWorkletCommand, PlaybackWorkletMessage } from "../worklet-messages.js";

/** Minimum buffered audio before a segment starts playing; absorbs network jitter without adding much delay. */
const PRIME_MS = 60;
const STATUS_EVERY_MS = 100;

interface Marker {
  segmentId: number;
  /** Absolute sample index (in written samples) at which this segment begins. */
  atSample: number;
}

/**
 * Jitter buffer + catch-up time stretch. Audio arrives tagged by segment so we can report the exact
 * context time at which each segment became audible (the `playbackStart` trace hop).
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring = new RingBuffer(sampleRate * 30);
  private readonly stretcher = new TimeStretcher(512);
  private readonly smoother = new RateSmoother(0.01);
  private readonly markers: Marker[] = [];
  private written = 0;
  private consumed = 0;
  private primed = false;
  private playing = false;
  private lastStatusTime = 0;
  private scratch = new Float32Array(0);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<PlaybackWorkletCommand>) => this.onCommand(e.data);
  }

  private onCommand(cmd: PlaybackWorkletCommand): void {
    switch (cmd.type) {
      case "push": {
        const last = this.markers[this.markers.length - 1];
        if (!last || last.segmentId !== cmd.segmentId)
          this.markers.push({ segmentId: cmd.segmentId, atSample: this.written });
        const dropped = this.ring.write(cmd.pcm);
        this.written += cmd.pcm.length;
        if (dropped > 0) this.consumed += dropped;
        break;
      }
      case "segmentEnd":
        break;
      case "flush":
        this.ring.clear();
        this.markers.length = 0;
        this.consumed = this.written;
        this.stretcher.reset();
        this.primed = false;
        break;
    }
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const backlogMs = (this.ring.length / sampleRate) * 1000;

    if (!this.primed) {
      if (backlogMs < PRIME_MS) {
        out.fill(0);
        this.setPlaying(false);
        this.maybeStatus(backlogMs, 1);
        return true;
      }
      this.primed = true;
    }
    if (this.ring.length === 0) {
      out.fill(0);
      this.primed = false;
      this.setPlaying(false);
      this.maybeStatus(0, 1);
      return true;
    }

    const rate = this.smoother.update(catchUpRate(backlogMs, DEFAULT_CATCH_UP));
    const needed = this.stretcher.inputNeeded(out.length, rate);
    if (this.scratch.length < needed) this.scratch = new Float32Array(needed);
    const avail = this.ring.peek(this.scratch.subarray(0, needed));
    const consumedNow = this.stretcher.process(
      this.scratch.subarray(0, Math.max(avail, 1)),
      out,
      rate,
    );
    this.ring.skip(consumedNow);
    this.announceMarkers(this.consumed, this.consumed + consumedNow);
    this.consumed += consumedNow;
    this.setPlaying(true);
    this.maybeStatus(backlogMs, rate);
    return true;
  }

  private announceMarkers(from: number, to: number): void {
    while (this.markers.length > 0) {
      const m = this.markers[0] as Marker;
      if (m.atSample >= to) break;
      if (m.atSample >= from || m.atSample < from) {
        this.post({ type: "segmentStart", segmentId: m.segmentId, contextTime: currentTime });
      }
      this.markers.shift();
    }
  }

  private setPlaying(p: boolean): void {
    this.playing = p;
  }

  private maybeStatus(backlogMs: number, rate: number): void {
    if ((currentTime - this.lastStatusTime) * 1000 < STATUS_EVERY_MS) return;
    this.lastStatusTime = currentTime;
    this.post({ type: "status", backlogMs, rate, playing: this.playing });
  }

  private post(m: PlaybackWorkletMessage): void {
    this.port.postMessage(m);
  }
}

registerProcessor("nyv-playback", PlaybackProcessor);
