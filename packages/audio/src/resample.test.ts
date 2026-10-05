import { describe, expect, it } from "vitest";
import { floatToInt16, int16ToFloat, Resampler } from "./resample.js";

describe("Resampler", () => {
  it("produces the right number of samples across chunk boundaries", () => {
    const r = new Resampler(48000, 16000);
    let total = 0;
    for (let i = 0; i < 100; i++) total += r.process(new Float32Array(128)).length;
    expect(total).toBeGreaterThanOrEqual(Math.floor((128 * 100) / 3) - 1);
    expect(total).toBeLessThanOrEqual(Math.ceil((128 * 100) / 3) + 1);
  });

  it("preserves a slow ramp", () => {
    const r = new Resampler(32000, 16000);
    const input = Float32Array.from({ length: 64 }, (_, i) => i / 64);
    const out = r.process(input);
    for (let i = 2; i < out.length; i++)
      expect((out[i] as number) - (out[i - 1] as number)).toBeCloseTo(2 / 64, 5);
  });

  it("is a no-op at equal rates", () => {
    const r = new Resampler(16000, 16000);
    const input = new Float32Array([0.1, 0.2]);
    expect(r.process(input)).toBe(input);
  });
});

describe("pcm conversion", () => {
  it("round-trips and clips", () => {
    const f = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
    const i = floatToInt16(f);
    expect(Array.from(i)).toEqual([0, 16384, -16384, 32767, -32768]);
    const back = int16ToFloat(i);
    expect(back[1]).toBeCloseTo(0.5, 3);
  });
});
