import { floatToInt16, Resampler } from "../resample.js";
import { EnergyVad, rmsDb } from "../vad.js";
import type { CaptureWorkletMessage } from "../worklet-messages.js";

const TARGET_RATE = 16000;
const CHUNK_MS = 20;

/** Mixes input to mono, downsamples to 16 kHz, runs VAD, posts 20 ms PCM16 chunks. */
class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new Resampler(sampleRate, TARGET_RATE);
  private readonly vad = new EnergyVad();
  private readonly chunkSize = (TARGET_RATE * CHUNK_MS) / 1000;
  private acc = new Float32Array(0);

  override process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const n = channels[0].length;
    const mono = new Float32Array(n);
    for (const ch of channels)
      for (let i = 0; i < n; i++)
        mono[i] = (mono[i] as number) + (ch[i] as number) / channels.length;

    const down = this.resampler.process(mono);
    const merged = new Float32Array(this.acc.length + down.length);
    merged.set(this.acc);
    merged.set(down, this.acc.length);
    let offset = 0;
    while (merged.length - offset >= this.chunkSize) {
      const frame = merged.subarray(offset, offset + this.chunkSize);
      offset += this.chunkSize;
      const vad = this.vad.process(frame, currentTime * 1000);
      if (vad) this.post({ type: "vad", event: vad });
      const pcm = floatToInt16(frame);
      this.port.postMessage(
        { type: "pcm", pcm, level: rmsDb(frame) } satisfies CaptureWorkletMessage,
        [pcm.buffer],
      );
    }
    this.acc = merged.slice(offset);
    return true;
  }

  private post(m: CaptureWorkletMessage): void {
    this.port.postMessage(m);
  }
}

registerProcessor("parley-capture", CaptureProcessor);
