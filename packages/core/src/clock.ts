export interface Clock {
  /** Milliseconds, monotonic, arbitrary origin. */
  now(): number;
}

export const monotonicClock: Clock = {
  now: () => performance.now(),
};

/** Clock whose origin is the moment it was created; makes trace numbers human-sized. */
export class SessionClock implements Clock {
  private readonly origin: number;
  constructor(private readonly base: Clock = monotonicClock) {
    this.origin = base.now();
  }
  now(): number {
    return this.base.now() - this.origin;
  }
}

export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
