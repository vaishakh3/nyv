import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FrameDecodeError,
  FrameFlags,
  FrameKind,
} from "./frames.js";

describe("audio frames", () => {
  it("round-trips header and samples", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = encodeFrame({
      kind: FrameKind.TranslatedAudio,
      flags: FrameFlags.SegmentEnd,
      seq: 0xdeadbeef,
      tsMs: 123456,
      segmentId: 42,
      pcm,
    });
    expect(bytes.byteLength).toBe(FRAME_HEADER_BYTES + pcm.byteLength);
    const back = decodeFrame(bytes);
    expect(back.kind).toBe(FrameKind.TranslatedAudio);
    expect(back.flags).toBe(FrameFlags.SegmentEnd);
    expect(back.seq).toBe(0xdeadbeef);
    expect(back.tsMs).toBe(123456);
    expect(back.segmentId).toBe(42);
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
  });

  it("decodes from an offset view", () => {
    const pcm = Int16Array.from([5, 6, 7]);
    const bytes = encodeFrame({
      kind: FrameKind.CaptureAudio,
      flags: 0,
      seq: 1,
      tsMs: 2,
      segmentId: 0,
      pcm,
    });
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);
    const view = new Uint8Array(padded.buffer, 3, bytes.byteLength);
    expect(Array.from(decodeFrame(view).pcm)).toEqual([5, 6, 7]);
  });

  it("rejects malformed frames", () => {
    expect(() => decodeFrame(new Uint8Array(3))).toThrow(FrameDecodeError);
    const bad = new Uint8Array(FRAME_HEADER_BYTES + 1);
    bad[0] = FrameKind.CaptureAudio;
    expect(() => decodeFrame(bad)).toThrow(/odd payload/);
    const unknown = new Uint8Array(FRAME_HEADER_BYTES);
    unknown[0] = 99;
    expect(() => decodeFrame(unknown)).toThrow(/unknown frame kind/);
  });
});
