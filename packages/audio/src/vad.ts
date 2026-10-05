/**
 * Energy-based VAD with adaptive noise floor and hangover. Good enough as the *client-side* gate
 * (vendors do the precise endpointing); its job is to send `speech.end` fast when the speaker stops
 * so the segmenter does not wait for the vendor's endpointing timeout.
 */
export interface VadOptions {
  /** dB above the noise floor to count as speech. */
  thresholdDb: number;
  /** Silence duration before speechEnd fires. */
  hangoverMs: number;
  /** Min speech duration before speechStart fires (filters clicks). */
  minSpeechMs: number;
  /** Noise floor adaptation speed in silence, per frame (0..1). */
  floorAdapt: number;
}

export const DEFAULT_VAD: VadOptions = {
  thresholdDb: 9,
  hangoverMs: 350,
  minSpeechMs: 80,
  floorAdapt: 0.05,
};

export type VadEvent = "speechStart" | "speechEnd";

export class EnergyVad {
  private floorDb = -60;
  private speaking = false;
  private speechSinceMs: number | undefined;
  private silenceSinceMs: number | undefined;

  constructor(private readonly opts: VadOptions = DEFAULT_VAD) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Feed one frame (≈10–30 ms). Returns an event when state flips. */
  process(frame: Float32Array, nowMs: number): VadEvent | undefined {
    const db = rmsDb(frame);
    const loud = db > this.floorDb + this.opts.thresholdDb;
    if (!loud) {
      // Track the noise floor downward quickly and upward slowly.
      this.floorDb += (db - this.floorDb) * (db < this.floorDb ? 0.3 : this.opts.floorAdapt);
    }
    if (loud) {
      this.silenceSinceMs = undefined;
      if (!this.speaking) {
        this.speechSinceMs ??= nowMs;
        if (nowMs - this.speechSinceMs >= this.opts.minSpeechMs) {
          this.speaking = true;
          return "speechStart";
        }
      }
    } else {
      this.speechSinceMs = undefined;
      if (this.speaking) {
        this.silenceSinceMs ??= nowMs;
        if (nowMs - this.silenceSinceMs >= this.opts.hangoverMs) {
          this.speaking = false;
          this.silenceSinceMs = undefined;
          return "speechEnd";
        }
      }
    }
    return undefined;
  }
}

export function rmsDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += (frame[i] as number) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return 20 * Math.log10(rms + 1e-9);
}
