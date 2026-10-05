/**
 * Maps audio-timeline milliseconds (what ASR word timestamps are in) to session-clock milliseconds
 * (what every other hop is stamped in), using the arrival time of each capture frame.
 */
export class AudioTimeline {
  private readonly frames: Array<{ audioEndMs: number; arrivalMs: number }> = [];
  private audioMs = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly keep = 2000,
  ) {}

  /** Record that a frame of `samples` samples arrived at `arrivalMs` on the session clock. */
  record(samples: number, arrivalMs: number): void {
    this.audioMs += (samples / this.sampleRate) * 1000;
    this.frames.push({ audioEndMs: this.audioMs, arrivalMs });
    if (this.frames.length > this.keep) this.frames.splice(0, this.frames.length - this.keep);
  }

  /** Total audio received so far, ms. */
  get positionMs(): number {
    return this.audioMs;
  }

  /** Session-clock time at which the audio containing `audioMs` arrived. */
  arrivalOf(audioMs: number): number | undefined {
    let lo = 0;
    let hi = this.frames.length - 1;
    if (hi < 0) return undefined;
    if (audioMs > (this.frames[hi] as { audioEndMs: number }).audioEndMs)
      return this.frames[hi]?.arrivalMs;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.frames[mid] as { audioEndMs: number }).audioEndMs < audioMs) lo = mid + 1;
      else hi = mid;
    }
    return this.frames[lo]?.arrivalMs;
  }
}
