import { readFileSync } from "node:fs";
import {
  type LatencyReport,
  type Percentiles,
  type Providers,
  summarize,
  TranslationSession,
} from "@nyv/core";
import type { HopTimings, SessionConfig } from "@nyv/protocol";

export interface BenchOptions {
  providers: Providers;
  config: SessionConfig;
  /** 16 kHz mono PCM16 to feed; silence of `durationMs` when omitted (fine for the mock ASR). */
  audio?: Int16Array;
  durationMs: number;
  /** Send audio faster than real time (mock only; vendors need real-time pacing). */
  speed?: number;
  /** Simulated client: jitter-buffer prime + network one-way delay added before "playback". */
  playbackDelayMs?: number;
  onLog?: (line: string) => void;
}

export interface BenchResult {
  report: LatencyReport;
  segments: Array<{ segmentId: number; source: string; target: string; hops: HopTimings }>;
}

const FRAME_MS = 20;

/** Drives a TranslationSession in-process with paced audio and a simulated client, collecting per-hop traces. */
export async function runBench(o: BenchOptions): Promise<BenchResult> {
  const speed = o.speed ?? 1;
  const playbackDelay = o.playbackDelayMs ?? 80;
  const frameSamples = (o.config.inputSampleRate * FRAME_MS) / 1000;
  const totalSamples = Math.ceil((o.durationMs / 1000) * o.config.inputSampleRate);
  const audio = o.audio ?? new Int16Array(totalSamples);
  const texts = new Map<number, { source: string; target: string }>();
  const traces = new Map<number, HopTimings>();
  let stopped: (() => void) | undefined;
  const stoppedP = new Promise<void>((r) => {
    stopped = r;
  });

  const session = new TranslationSession(
    { sessionId: "bench", config: o.config, providers: o.providers },
    {
      onMessage: (m) => {
        switch (m.type) {
          case "transcript":
            if (m.final)
              texts.set(m.segmentId, {
                source: m.text,
                target: texts.get(m.segmentId)?.target ?? "",
              });
            break;
          case "translation":
            if (m.final)
              texts.set(m.segmentId, {
                source: texts.get(m.segmentId)?.source ?? "",
                target: m.text,
              });
            break;
          case "segment.audio.start":
            session.reportPlayback(m.segmentId, session.clock.now() + playbackDelay);
            break;
          case "trace":
            traces.set(m.segmentId, m.hops);
            break;
          case "error":
            o.onLog?.(`error: ${m.code} ${m.message}`);
            break;
          case "session.stopped":
            stopped?.();
            break;
          default:
            break;
        }
      },
      onAudio: () => {},
    },
  );

  await session.start();
  const started = performance.now();
  let sent = 0;
  while (sent < audio.length) {
    const frame = audio.subarray(sent, Math.min(audio.length, sent + frameSamples));
    session.pushAudio(frame);
    sent += frameSamples;
    const due = started + ((sent / o.config.inputSampleRate) * 1000) / speed;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
  }
  session.speechEnded();
  // Let the tail segments drain, then stop.
  await sleep(Math.max(1500, playbackDelay * 2) / speed);
  await session.stop("bench_done");
  await stoppedP;

  const segments = [...traces.entries()]
    .sort(([a], [b]) => a - b)
    .map(([segmentId, hops]) => ({
      segmentId,
      hops,
      ...(texts.get(segmentId) ?? { source: "", target: "" }),
    }));
  return { report: summarize(traces.values()), segments };
}

export function readWav16k(path: string): Int16Array {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (rate !== 16000 || bits !== 16)
    throw new Error(`need 16 kHz PCM16 WAV, got ${rate} Hz / ${bits}-bit`);
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const frames = size / 2 / channels;
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(off + 8 + i * 2 * channels);
      return out;
    }
    off += 8 + size;
  }
  throw new Error("no data chunk");
}

export function formatReport(r: LatencyReport): string {
  const rows: Array<[string, Percentiles | undefined]> = [
    ["speechEnd → playback (perceived)", r.endToEnd],
    ["speechEnd → ASR final", r.asr],
    ["ASR final → MT first token", r.mtFirstToken],
    ["ASR final → MT done", r.mt],
    ["MT first token → TTS first byte", r.ttsFirstByte],
    ["TTS first byte → playback", r.transport],
  ];
  const w = Math.max(...rows.map(([n]) => n.length));
  const lines = [
    `${"hop".padEnd(w)}  ${"n".padStart(4)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"max".padStart(7)}`,
  ];
  for (const [name, p] of rows) {
    lines.push(
      p
        ? `${name.padEnd(w)}  ${String(p.n).padStart(4)} ${ms(p.p50)} ${ms(p.p95)} ${ms(p.max)}`
        : `${name.padEnd(w)}  ${"-".padStart(4)}`,
    );
  }
  return lines.join("\n");
}

const ms = (v: number) => `${Math.round(v)}ms`.padStart(7);

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

/** Regression gate: fail when perceived-latency p50/p95 worsen by more than `tolerance` vs baseline. */
export function gate(current: LatencyReport, baseline: LatencyReport, tolerance = 0.1): GateResult {
  const reasons: string[] = [];
  const cur = current.endToEnd;
  const base = baseline.endToEnd;
  if (!cur) reasons.push("no end-to-end measurements");
  else if (base) {
    if (cur.p50 > base.p50 * (1 + tolerance))
      reasons.push(
        `p50 ${Math.round(cur.p50)}ms > baseline ${Math.round(base.p50)}ms (+${pct(cur.p50, base.p50)})`,
      );
    if (cur.p95 > base.p95 * (1 + tolerance))
      reasons.push(
        `p95 ${Math.round(cur.p95)}ms > baseline ${Math.round(base.p95)}ms (+${pct(cur.p95, base.p95)})`,
      );
    if (cur.n < base.n) reasons.push(`fewer segments than baseline (${cur.n} < ${base.n})`);
  }
  return { ok: reasons.length === 0, reasons };
}

const pct = (a: number, b: number) => `${Math.round(((a - b) / b) * 100)}%`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
