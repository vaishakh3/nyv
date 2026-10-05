/**
 * Overlap-add time stretcher (pitch-preserving speed-up for speech). Grains of `grainSize` samples
 * with 50% Hann overlap are read from the input at `rate × hop` and written at `hop`. At rate 1.0 the
 * output is sample-exact (crossfaded grains sum to unity). Quality is good for 1.0–1.4x, which is all
 * catch-up playback needs. Deliberately not WSOLA: no search, deterministic CPU cost in the audio thread.
 */
export class TimeStretcher {
  private readonly window: Float32Array;
  private readonly hop: number;
  private readonly tail: Float32Array; // overlap carried into the next grain

  constructor(readonly grainSize = 512) {
    if (grainSize % 2 !== 0) throw new Error("grainSize must be even");
    this.hop = grainSize / 2;
    this.window = new Float32Array(grainSize);
    for (let i = 0; i < grainSize; i++)
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grainSize);
    this.tail = new Float32Array(this.hop);
  }

  /** Input samples needed to produce `outSamples` at `rate`, plus one grain of lookahead. */
  inputNeeded(outSamples: number, rate: number): number {
    return Math.ceil(outSamples * rate) + this.grainSize;
  }

  /**
   * Produces exactly out.length samples at the given rate, consuming roughly out.length × rate input samples
   * from `input` (which must be at least inputNeeded() long for seamless output). Returns samples consumed.
   */
  process(input: Float32Array, out: Float32Array, rate: number): number {
    if (rate === 1) {
      const n = Math.min(out.length, input.length);
      out.set(input.subarray(0, n));
      out.fill(0, n);
      return n;
    }
    let written = 0;
    let readPos = 0;
    const h = this.hop;
    while (written < out.length) {
      const start = Math.floor(readPos);
      // Output hop: first half is tail + head of this grain, second half becomes the new tail.
      for (let i = 0; i < h && written < out.length; i++) {
        const s = start + i < input.length ? (input[start + i] as number) : 0;
        out[written++] = (this.tail[i] as number) + s * (this.window[i] as number);
      }
      for (let i = 0; i < h; i++) {
        const s = start + h + i < input.length ? (input[start + h + i] as number) : 0;
        this.tail[i] = s * (this.window[h + i] as number);
      }
      readPos += h * rate;
    }
    return Math.min(input.length, Math.round(readPos));
  }

  reset(): void {
    this.tail.fill(0);
  }
}
