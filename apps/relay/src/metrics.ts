import type { HopTimings } from "@fyv/protocol";

/** Relay-wide counters plus a rolling window of perceived latencies, rendered in Prometheus text format. */
export class Metrics {
  sessionsActive = 0;
  sessionsTotal = 0;
  segmentsTotal = 0;
  errorsTotal = 0;
  readonly rejected = new Map<string, number>();
  private readonly e2e: number[] = [];

  constructor(private readonly window = 2000) {}

  reject(reason: string): void {
    this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + 1);
  }

  observe(hops: HopTimings): void {
    if (hops.speechEnd === undefined || hops.playbackStart === undefined) return;
    this.segmentsTotal++;
    this.e2e.push(hops.playbackStart - hops.speechEnd);
    if (this.e2e.length > this.window) this.e2e.splice(0, this.e2e.length - this.window);
  }

  quantile(q: number): number | undefined {
    if (this.e2e.length === 0) return undefined;
    const sorted = [...this.e2e].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  render(): string {
    const lines = [
      "# TYPE fyv_sessions_active gauge",
      `fyv_sessions_active ${this.sessionsActive}`,
      "# TYPE fyv_sessions_total counter",
      `fyv_sessions_total ${this.sessionsTotal}`,
      "# TYPE fyv_segments_total counter",
      `fyv_segments_total ${this.segmentsTotal}`,
      "# TYPE fyv_errors_total counter",
      `fyv_errors_total ${this.errorsTotal}`,
      "# TYPE fyv_rejected_total counter",
    ];
    for (const [reason, n] of this.rejected)
      lines.push(`fyv_rejected_total{reason="${reason}"} ${n}`);
    lines.push("# TYPE fyv_perceived_latency_ms summary");
    for (const q of [0.5, 0.95, 0.99]) {
      const v = this.quantile(q);
      if (v !== undefined) lines.push(`fyv_perceived_latency_ms{quantile="${q}"} ${Math.round(v)}`);
    }
    lines.push(`fyv_perceived_latency_ms_count ${this.e2e.length}`);
    return `${lines.join("\n")}\n`;
  }
}
