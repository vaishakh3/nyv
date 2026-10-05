/**
 * Stateful linear-interpolation resampler for mono Float32 audio. Linear is adequate for
 * 48k→16k speech capture given the downstream ASR models downsample anyway; it keeps the worklet cheap.
 */
export class Resampler {
  private readonly ratio: number;
  private last = 0;
  private pos = 0; // fractional read position relative to the start of the current input block (+1 history sample)

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return input;
    // Virtual signal: [last, ...input]; positions are indices into it.
    const total = input.length + 1;
    const at = (i: number) => (i === 0 ? this.last : (input[i - 1] as number));
    const out: number[] = [];
    let p = this.pos;
    while (p <= total - 1) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = at(i);
      const b = i + 1 < total ? at(i + 1) : a;
      out.push(a + (b - a) * frac);
      p += this.ratio;
    }
    this.pos = p - (total - 1);
    this.last = input.length > 0 ? (input[input.length - 1] as number) : this.last;
    return Float32Array.from(out);
  }

  reset(): void {
    this.last = 0;
    this.pos = 0;
  }
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] as number));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = (input[i] as number) / 32768;
  return out;
}
