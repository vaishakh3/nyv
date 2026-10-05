/** Messages between the main thread and the audio worklets. */
export type CaptureWorkletMessage =
  | { type: "pcm"; pcm: Int16Array; level: number } // 16 kHz PCM16 chunk (~20 ms) + RMS dB
  | { type: "vad"; event: "speechStart" | "speechEnd" };

export type PlaybackWorkletCommand =
  | { type: "push"; segmentId: number; pcm: Float32Array } // already at the context sample rate
  | { type: "segmentEnd"; segmentId: number }
  | { type: "flush" };

export type PlaybackWorkletMessage =
  | { type: "segmentStart"; segmentId: number; contextTime: number }
  | { type: "status"; backlogMs: number; rate: number; playing: boolean };
