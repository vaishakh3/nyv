export function int16ToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] as number, true);
  return out;
}

export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generates a sine tone; used by the mock TTS so playback paths can be heard and measured. */
export function tone(
  durationMs: number,
  sampleRate: number,
  hz = 440,
  amplitude = 0.2,
): Int16Array {
  const n = Math.round((durationMs / 1000) * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 200, (n - i) / 200); // 200-sample fade to avoid clicks
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * env * 32767);
  }
  return out;
}
