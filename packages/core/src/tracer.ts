import type { HopTimings } from "@nyv/protocol";
import type { Clock } from "./clock.js";

export type Hop = keyof HopTimings;

/** Per-segment timestamps for every pipeline hop, on one clock. */
export class Tracer {
  private readonly segments = new Map<number, HopTimings>();

  constructor(private readonly clock: Clock) {}

  mark(segmentId: number, hop: Hop, at: number = this.clock.now()): void {
    const hops = this.segments.get(segmentId) ?? {};
    if (hops[hop] === undefined) hops[hop] = at; // first occurrence wins (e.g. first token, first byte)
    this.segments.set(segmentId, hops);
  }

  get(segmentId: number): HopTimings | undefined {
    return this.segments.get(segmentId);
  }

  all(): Array<{ segmentId: number; hops: HopTimings }> {
    return [...this.segments.entries()].map(([segmentId, hops]) => ({ segmentId, hops }));
  }
}

export interface HopDurations {
  /** speechEnd → playbackStart: the number the listener feels. */
  endToEnd?: number;
  /** speechEnd → asrFinal */
  asr?: number;
  /** asrFinal → mtFirstToken */
  mtFirstToken?: number;
  /** asrFinal − mtStart: how far ahead of the final transcript the translation was requested (speculation). */
  mtLead?: number;
  /** mtStart → mtFirstToken: the vendor's time to first token. */
  mtTtft?: number;
  /** asrFinal → mtDone */
  mt?: number;
  /** mtFirstToken → ttsFirstByte */
  ttsFirstByte?: number;
  /** ttsFirstByte → playbackStart */
  transport?: number;
}

export function durations(h: HopTimings): HopDurations {
  const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : undefined);
  const out: HopDurations = {};
  const e2e = d(h.speechEnd, h.playbackStart);
  if (e2e !== undefined) out.endToEnd = e2e;
  const asr = d(h.speechEnd, h.asrFinal);
  if (asr !== undefined) out.asr = asr;
  const mtf = d(h.asrFinal, h.mtFirstToken);
  if (mtf !== undefined) out.mtFirstToken = mtf;
  const lead = d(h.mtStart, h.asrFinal);
  if (lead !== undefined) out.mtLead = lead;
  const ttft = d(h.mtStart, h.mtFirstToken);
  if (ttft !== undefined) out.mtTtft = ttft;
  const mt = d(h.asrFinal, h.mtDone);
  if (mt !== undefined) out.mt = mt;
  const ttsf = d(h.mtFirstToken, h.ttsFirstByte);
  if (ttsf !== undefined) out.ttsFirstByte = ttsf;
  const tr = d(h.ttsFirstByte, h.playbackStart);
  if (tr !== undefined) out.transport = tr;
  return out;
}

export interface Percentiles {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function percentiles(values: number[]): Percentiles | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
  return { n: sorted.length, p50: at(50), p95: at(95), max: sorted[sorted.length - 1] as number };
}

export type LatencyReport = { [K in keyof HopDurations]?: Percentiles };

export function summarize(traces: Iterable<HopTimings>): LatencyReport {
  const buckets: { [K in keyof HopDurations]?: number[] } = {};
  for (const t of traces) {
    const d = durations(t);
    for (const key of Object.keys(d) as Array<keyof HopDurations>) {
      const v = d[key];
      if (v === undefined) continue;
      const bucket = buckets[key] ?? [];
      bucket.push(v);
      buckets[key] = bucket;
    }
  }
  const report: LatencyReport = {};
  for (const key of Object.keys(buckets) as Array<keyof HopDurations>) {
    const p = percentiles(buckets[key] ?? []);
    if (p) report[key] = p;
  }
  return report;
}
