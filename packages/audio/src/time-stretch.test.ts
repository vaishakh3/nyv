import { describe, expect, it } from "vitest";
import { TimeStretcher } from "./time-stretch.js";

const sine = (n: number, hz = 440, sr = 48000) =>
  Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sr));

/** Streams `input` through the stretcher in worklet-sized (128) blocks; returns the output and samples consumed. */
function stream(ts: TimeStretcher, input: Float32Array, rate: number, outSamples: number) {
  const out: number[] = [];
  let pos = 0;
  while (out.length < outSamples) {
    const block = new Float32Array(128);
    pos += ts.process(input.subarray(pos, pos + ts.inputNeeded(128, rate)), block, rate);
    out.push(...block);
  }
  return { out, consumed: pos };
}

describe("TimeStretcher", () => {
  it("is transparent at rate 1", () => {
    const ts = new TimeStretcher(64);
    const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 5));
    const out = new Float32Array(128);
    expect(ts.process(input, out, 1)).toBe(128);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(input[i] as number, 6);
  });

  it("consumes ~rate× input and keeps amplitude for a DC signal", () => {
    const ts = new TimeStretcher(64);
    const input = new Float32Array(4096).fill(0.5);
    const out = new Float32Array(1024);
    ts.process(input, out, 1.3);
    const consumed = ts.process(input, out, 1.3);
    expect(consumed).toBeGreaterThan(1024 * 1.2);
    expect(consumed).toBeLessThan(1024 * 1.4);
    for (const s of out) expect(s).toBeCloseTo(0.5, 2);
  });

  it("stays click-free when pulled in 128-sample blocks at every catch-up rate", () => {
    // Regression: the previous implementation truncated a grain whenever the output block was smaller
    // than the hop, producing a hard discontinuity every block (audible as constant static).
    const maxSineStep = 0.5 * 2 * Math.PI * (440 / 48000);
    for (const rate of [1.01, 1.1, 1.2, 1.35]) {
      const { out, consumed } = stream(new TimeStretcher(960), sine(48000 * 3), rate, 48000);
      let maxStep = 0;
      for (let i = 1; i < out.length; i++)
        maxStep = Math.max(maxStep, Math.abs((out[i] as number) - (out[i - 1] as number)));
      expect(maxStep).toBeLessThan(maxSineStep * 1.05);
      expect(consumed / out.length).toBeCloseTo(rate, 2);
    }
  });

  it("preserves pitch and amplitude while speeding up", () => {
    const { out } = stream(new TimeStretcher(960), sine(48000 * 3), 1.35, 48000 * 2);
    let crossings = 0;
    for (let i = 48001; i < out.length; i++)
      if ((out[i - 1] as number) < 0 !== (out[i] as number) < 0) crossings++;
    expect(crossings / 2).toBeGreaterThan(435);
    expect(crossings / 2).toBeLessThan(445);
    for (let b = 48000; b + 480 <= out.length; b += 480) {
      let energy = 0;
      for (let i = b; i < b + 480; i++) energy += (out[i] as number) ** 2;
      expect(Math.sqrt(energy / 480)).toBeCloseTo(0.5 / Math.SQRT2, 1);
    }
  });
});

it("at rate 1 with nothing pending, consumed equals emitted so a direct ring copy can take over seamlessly", () => {
  const ts = new TimeStretcher(960);
  const input = sine(48000);
  let pos = 0;
  let emitted = 0;
  const joined: number[] = [];
  for (let b = 0; b < 40; b++) {
    const block = new Float32Array(128);
    pos += ts.process(input.subarray(pos, pos + ts.inputNeeded(128, 1)), block, 1);
    emitted += 128;
    joined.push(...block);
    if (ts.pending() === 0) expect(pos).toBe(emitted);
  }
  // Drain until the FIFO is empty, then hand over to a plain copy and check continuity.
  while (ts.pending() > 0) {
    const block = new Float32Array(128);
    pos += ts.process(input.subarray(pos, pos + ts.inputNeeded(128, 1)), block, 1);
    emitted += 128;
    joined.push(...block);
  }
  expect(pos).toBe(emitted);
  joined.push(...input.subarray(pos, pos + 256));
  for (let i = 0; i < joined.length; i++) expect(joined[i]).toBeCloseTo(input[i] as number, 5);
});
