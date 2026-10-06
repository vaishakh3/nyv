/**
 * Streaming WSOLA time stretcher (pitch-preserving speed-up for speech).
 *
 * Grains of `grainSize` samples with 50% Hann overlap are read from the input at `rate × hop` and written
 * at `hop`. Before each grain is cut, its start is nudged by up to ±`hop/2` samples to the position that best
 * continues the waveform the previous grain ended on (normalised cross-correlation with the natural
 * continuation), so overlapping grains add in phase instead of beating against each other. Output is
 * produced a hop at a time into an internal FIFO, so callers may pull any block size (the worklet pulls
 * 128) without ever truncating a grain. At rate 1 the output is sample-exact.
 *
 * Deterministic CPU cost: one correlation search per hop, no allocation in `process`.
 */
export class TimeStretcher {
  private readonly window: Float32Array;
  private readonly hop: number;
  private readonly tolerance: number;
  private readonly corrLen: number;
  private readonly tail: Float32Array; // windowed second half of the previous grain
  private readonly natural: Float32Array; // what would have followed the previous grain in the input
  private readonly fifo: Float32Array;
  private fifoPos = 0;
  private fifoLen = 0;
  private readPos = 0; // fractional nominal read position, relative to the start of the current input
  private haveNatural = false;

  constructor(readonly grainSize = 960) {
    if (grainSize % 4 !== 0) throw new Error("grainSize must be a multiple of 4");
    this.hop = grainSize / 2;
    this.tolerance = this.hop / 2;
    this.corrLen = this.hop / 2;
    this.window = new Float32Array(grainSize);
    for (let i = 0; i < grainSize; i++)
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grainSize);
    this.tail = new Float32Array(this.hop);
    this.natural = new Float32Array(this.corrLen);
    this.fifo = new Float32Array(this.hop);
  }

  /** Input samples needed to produce `outSamples` at `rate` without running past the end of `input`. */
  inputNeeded(outSamples: number, rate: number): number {
    return Math.ceil(outSamples * rate) + this.grainSize + 2 * this.tolerance;
  }

  /**
   * Produces exactly out.length samples at the given rate, consuming roughly out.length × rate input
   * samples from `input` (which should be at least inputNeeded() long; shorter input is zero-padded).
   * Returns samples consumed.
   */
  process(input: Float32Array, out: Float32Array, rate: number): number {
    let written = 0;
    while (written < out.length) {
      if (this.fifoPos < this.fifoLen) {
        const n = Math.min(this.fifoLen - this.fifoPos, out.length - written);
        out.set(this.fifo.subarray(this.fifoPos, this.fifoPos + n), written);
        this.fifoPos += n;
        written += n;
        continue;
      }
      this.synthesizeHop(input, rate);
    }
    const consumed = Math.min(input.length, Math.floor(this.readPos));
    this.readPos -= consumed;
    return consumed;
  }

  private synthesizeHop(input: Float32Array, rate: number): void {
    const h = this.hop;
    const w = this.window;
    const nominal = Math.floor(this.readPos);
    const start = nominal + this.bestOffset(input, nominal, rate);
    const at = (i: number) => (i >= 0 && i < input.length ? (input[i] as number) : 0);

    // First grain after a reset has no overlap partner: emit it unwindowed so playback starts sample-exact.
    if (this.haveNatural)
      for (let i = 0; i < h; i++)
        this.fifo[i] = (this.tail[i] as number) + at(start + i) * (w[i] as number);
    else for (let i = 0; i < h; i++) this.fifo[i] = at(start + i);
    for (let i = 0; i < h; i++) this.tail[i] = at(start + h + i) * (w[h + i] as number);
    for (let i = 0; i < this.corrLen; i++) this.natural[i] = at(start + h + i);
    this.haveNatural = true;

    this.fifoPos = 0;
    this.fifoLen = h;
    this.readPos += h * rate;
  }

  /** Offset in [-tolerance, tolerance] whose grain head best matches the previous grain's natural continuation. */
  private bestOffset(input: Float32Array, nominal: number, rate: number): number {
    if (!this.haveNatural || Math.abs(rate - 1) < 1e-3) return 0;
    const nat = this.natural;
    const len = this.corrLen;
    let natEnergy = 0;
    for (let i = 0; i < len; i++) natEnergy += (nat[i] as number) ** 2;
    if (natEnergy < 1e-9) return 0;

    const lo = Math.max(-this.tolerance, -nominal);
    const hi = Math.min(this.tolerance, input.length - nominal - this.grainSize);
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let off = lo; off <= hi; off++) {
      const base = nominal + off;
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < len; i++) {
        const s = input[base + i] as number;
        dot += s * (nat[i] as number);
        energy += s * s;
      }
      if (energy < 1e-9) continue;
      const score = dot / Math.sqrt(energy * natEnergy);
      // Prefer the smaller displacement on (near-)ties, e.g. for DC or periodic signals.
      if (
        score > bestScore + 1e-6 ||
        (score > bestScore - 1e-6 && Math.abs(off) < Math.abs(best))
      ) {
        bestScore = score;
        best = off;
      }
    }
    return best;
  }

  /** Output samples already synthesized but not yet returned by `process`. */
  pending(): number {
    return this.fifoLen - this.fifoPos;
  }

  reset(): void {
    this.tail.fill(0);
    this.natural.fill(0);
    this.haveNatural = false;
    this.fifoPos = 0;
    this.fifoLen = 0;
    this.readPos = 0;
  }
}
