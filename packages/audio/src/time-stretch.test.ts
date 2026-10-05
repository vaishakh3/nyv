import { describe, expect, it } from "vitest";
import { TimeStretcher } from "./time-stretch.js";

describe("TimeStretcher", () => {
  it("is transparent at rate 1", () => {
    const ts = new TimeStretcher(64);
    const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 5));
    const out = new Float32Array(128);
    expect(ts.process(input, out, 1)).toBe(128);
    expect(Array.from(out)).toEqual(Array.from(input.subarray(0, 128)));
  });

  it("consumes ~rate× input and keeps amplitude for a DC signal", () => {
    const ts = new TimeStretcher(64);
    const input = new Float32Array(4096).fill(0.5);
    const out = new Float32Array(1024);
    // Warm up so the overlap tail is populated.
    ts.process(input, out, 1.3);
    const consumed = ts.process(input, out, 1.3);
    expect(consumed).toBeGreaterThan(1024 * 1.2);
    expect(consumed).toBeLessThan(1024 * 1.4);
    for (const s of out) expect(s).toBeCloseTo(0.5, 2);
  });
});
