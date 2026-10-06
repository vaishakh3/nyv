/**
 * Catch-up policy: translated speech runs longer than the original (Hindi ≈ 1.15–1.2× English), so the
 * backlog grows during long monologues. Rather than letting the listener drift seconds behind, we speed
 * playback up smoothly once the backlog exceeds a comfort threshold.
 */
export interface CatchUpOptions {
  /** Backlog below which we play at 1.0. */
  comfortMs: number;
  /** Backlog at which we hit maxRate. */
  panicMs: number;
  maxRate: number;
}

export const DEFAULT_CATCH_UP: CatchUpOptions = { comfortMs: 700, panicMs: 3000, maxRate: 1.5 };

export function catchUpRate(backlogMs: number, o: CatchUpOptions = DEFAULT_CATCH_UP): number {
  if (backlogMs <= o.comfortMs) return 1;
  if (backlogMs >= o.panicMs) return o.maxRate;
  const t = (backlogMs - o.comfortMs) / (o.panicMs - o.comfortMs);
  return 1 + (o.maxRate - 1) * t;
}

/** Smooths rate changes so the ear never hears a step. */
export class RateSmoother {
  private current = 1;
  constructor(private readonly maxDeltaPerUpdate = 0.02) {}
  update(target: number): number {
    const d = Math.max(
      -this.maxDeltaPerUpdate,
      Math.min(this.maxDeltaPerUpdate, target - this.current),
    );
    this.current += d;
    return this.current;
  }
  get rate(): number {
    return this.current;
  }
}
