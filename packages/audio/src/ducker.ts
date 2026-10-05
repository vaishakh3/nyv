/**
 * Ducking policy for the original call audio: pull it down while translated speech plays, bring it back
 * shortly after. Duck rather than mute so the listener keeps the speaker's prosody and turn-taking cues.
 */
export interface DuckerOptions {
  duckedGain: number;
  attackMs: number;
  releaseMs: number;
  /** Keep ducked this long after translated audio stops, bridging inter-segment gaps. */
  holdMs: number;
}

export const DEFAULT_DUCKER: DuckerOptions = {
  duckedGain: 0.12,
  attackMs: 60,
  releaseMs: 250,
  holdMs: 400,
};

export class Ducker {
  private lastActiveMs = Number.NEGATIVE_INFINITY;
  constructor(private readonly opts: DuckerOptions = DEFAULT_DUCKER) {}

  /** Call whenever translated audio is being played. */
  active(nowMs: number): void {
    this.lastActiveMs = nowMs;
  }

  /** Target gain for the original audio at `nowMs`, plus how fast to ramp there. */
  target(nowMs: number): { gain: number; rampMs: number } {
    const ducked = nowMs - this.lastActiveMs <= this.opts.holdMs;
    return ducked
      ? { gain: this.opts.duckedGain, rampMs: this.opts.attackMs }
      : { gain: 1, rampMs: this.opts.releaseMs };
  }
}
