import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LatencyReport } from "@nyv/core";
import { sessionConfig } from "@nyv/protocol";
import { DEMO_SCRIPT, MockAsrProvider, providersFromEnv } from "@nyv/providers";
import { formatReport, gate, readWav16k, runBench } from "./bench.js";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "en" },
    target: { type: "string", default: "hi" },
    wav: { type: "string" },
    speculation: { type: "boolean", default: false },
    runs: { type: "string", default: "1" },
    speed: { type: "string", default: "1" },
    out: { type: "string" },
    baseline: { type: "string" },
    tolerance: { type: "string", default: "0.10" },
    json: { type: "boolean", default: false },
  },
});

/** pnpm runs scripts in the package dir; resolve user paths against where `pnpm bench` was invoked. */
const userPath = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

const config = sessionConfig.parse({ sourceLang: values.source, targetLang: values.target });
const providers = providersFromEnv(process.env);
const audio = values.wav ? readWav16k(userPath(values.wav)) : undefined;
const durationMs = audio
  ? (audio.length / 16000) * 1000
  : providers.asr instanceof MockAsrProvider
    ? (DEMO_SCRIPT.at(-1)?.atMs ?? 0) + 600
    : 10_000;
const runs = Number(values.runs);
const speed = Number(values.speed);

const all: LatencyReport[] = [];
for (let i = 0; i < runs; i++) {
  const res = await runBench({
    providers,
    config,
    ...(audio ? { audio } : {}),
    durationMs,
    speed,
    speculative: values.speculation,
    onLog: (l) => console.error(l),
  });
  all.push(res.report);
  if (!values.json) {
    console.log(
      `\nrun ${i + 1}/${runs}  providers: ${providers.asr.name} / ${providers.mt.name} / ${providers.tts.name}`,
    );
    for (const s of res.segments) {
      const e2e =
        s.hops.playbackStart && s.hops.speechEnd
          ? `${Math.round(s.hops.playbackStart - s.hops.speechEnd)}ms`
          : "-";
      console.log(`  #${s.segmentId} ${e2e.padStart(7)}  ${s.source}  →  ${s.target}`);
    }
    console.log(formatReport(res.report));
    console.log(
      `speculative MT: ${res.speculation.hits} adopted / ${res.speculation.misses} discarded`,
    );
  }
}

// Merge runs by re-summarizing is not possible from percentiles; report the last run and the median of p50s.
const report = all[all.length - 1] as LatencyReport;
if (values.json) console.log(JSON.stringify(report, null, 2));
if (values.out) {
  const out = userPath(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
if (values.baseline) {
  const baseline = JSON.parse(readFileSync(userPath(values.baseline), "utf8")) as LatencyReport;
  const g = gate(report, baseline, Number(values.tolerance));
  if (g.ok)
    console.log(`\nlatency gate: OK (within ${Number(values.tolerance) * 100}% of baseline)`);
  else {
    console.error(`\nlatency gate: FAILED\n  ${g.reasons.join("\n  ")}`);
    process.exit(1);
  }
}
