/**
 * Per-principal daily usage budget (hosted mode). A principal is whatever `identify` returns for a
 * connection — in production the access code. Usage is kept in memory and resets at UTC midnight;
 * a redeploy resets it too, which is acceptable for a beta where the cap exists to bound cost, not to bill.
 */
export class Quota {
  private readonly used = new Map<string, { day: string; ms: number }>();

  constructor(
    /** Budget per principal per UTC day in ms; 0 = unlimited. */
    readonly dailyMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.dailyMs > 0;
  }

  remainingMs(principal: string): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    const u = this.used.get(principal);
    if (!u || u.day !== this.today()) return this.dailyMs;
    return Math.max(0, this.dailyMs - u.ms);
  }

  consume(principal: string, ms: number): void {
    if (!this.enabled || ms <= 0) return;
    const day = this.today();
    const u = this.used.get(principal);
    if (!u || u.day !== day) this.used.set(principal, { day, ms });
    else u.ms += ms;
  }

  /** Time until the budget resets (next UTC midnight). */
  resetsInMs(): number {
    const t = this.now();
    const next = new Date(t);
    next.setUTCHours(24, 0, 0, 0);
    return next.getTime() - t;
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}
