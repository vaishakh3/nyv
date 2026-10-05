import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("wraps, drops oldest when full, and zero-fills short reads", () => {
    const rb = new RingBuffer(4);
    expect(rb.write(new Float32Array([1, 2, 3]))).toBe(0);
    expect(rb.write(new Float32Array([4, 5]))).toBe(1);
    const out = new Float32Array(6);
    expect(rb.read(out)).toBe(4);
    expect(Array.from(out)).toEqual([2, 3, 4, 5, 0, 0]);
    expect(rb.length).toBe(0);
  });

  it("peeks with offset and skips", () => {
    const rb = new RingBuffer(8);
    rb.write(new Float32Array([1, 2, 3, 4, 5]));
    const out = new Float32Array(2);
    expect(rb.peek(out, 3)).toBe(2);
    expect(Array.from(out)).toEqual([4, 5]);
    expect(rb.skip(10)).toBe(5);
  });
});
