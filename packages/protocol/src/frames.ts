/**
 * Binary audio frame layout (little-endian), 16-byte header followed by PCM16LE mono samples.
 *
 *   0  u8   kind        FrameKind
 *   1  u8   flags       bit0 = last frame of segment
 *   2  u16  reserved
 *   4  u32  seq         per-direction monotonically increasing
 *   8  u32  tsMs        sender clock, ms since session start
 *  12  u32  segmentId   0 for inbound capture audio; the segment this audio belongs to for outbound TTS audio
 *  16  ...  payload     Int16 PCM samples
 *
 * Audio never travels as JSON: base64 adds 33% and a parse step on every 20 ms frame.
 */
export const FRAME_HEADER_BYTES = 16;

export const FrameKind = {
  /** Client → relay: captured speech, 16 kHz mono. */
  CaptureAudio: 1,
  /** Relay → client: synthesized translated speech, sample rate announced in session.ready. */
  TranslatedAudio: 2,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const FrameFlags = { None: 0, SegmentEnd: 1 } as const;

export interface AudioFrame {
  kind: FrameKind;
  flags: number;
  seq: number;
  tsMs: number;
  segmentId: number;
  pcm: Int16Array;
}

export function encodeFrame(frame: AudioFrame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.pcm.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.kind);
  view.setUint8(1, frame.flags);
  view.setUint16(2, 0, true);
  view.setUint32(4, frame.seq >>> 0, true);
  view.setUint32(8, frame.tsMs >>> 0, true);
  view.setUint32(12, frame.segmentId >>> 0, true);
  // Copy sample-by-sample so we never depend on the source array's alignment or endianness.
  for (let i = 0; i < frame.pcm.length; i++) {
    view.setInt16(FRAME_HEADER_BYTES + i * 2, frame.pcm[i] as number, true);
  }
  return out;
}

export class FrameDecodeError extends Error {}

export function decodeFrame(buf: ArrayBuffer | Uint8Array): AudioFrame {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    throw new FrameDecodeError(`frame too short: ${bytes.byteLength} bytes`);
  }
  if ((bytes.byteLength - FRAME_HEADER_BYTES) % 2 !== 0) {
    throw new FrameDecodeError("odd payload length for PCM16");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(0);
  if (kind !== FrameKind.CaptureAudio && kind !== FrameKind.TranslatedAudio) {
    throw new FrameDecodeError(`unknown frame kind ${kind}`);
  }
  const sampleCount = (bytes.byteLength - FRAME_HEADER_BYTES) / 2;
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(FRAME_HEADER_BYTES + i * 2, true);
  }
  return {
    kind,
    flags: view.getUint8(1),
    seq: view.getUint32(4, true),
    tsMs: view.getUint32(8, true),
    segmentId: view.getUint32(12, true),
    pcm,
  };
}

export function pcmDurationMs(sampleCount: number, sampleRate: number): number {
  return (sampleCount / sampleRate) * 1000;
}
