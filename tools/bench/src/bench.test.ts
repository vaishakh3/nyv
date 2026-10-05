import { MockAsrProvider, MockMtProvider, MockTtsProvider } from "@parley/providers";
import { describe, expect, it } from "vitest";
import { formatReport, gate, runBench } from "./bench.js";

describe("bench", () => {
  it("measures every hop for a scripted session", async () => {
    const res = await runBench({
      providers: {
        asr: new MockAsrProvider({
          script: [
            { atMs: 300, text: "One." },
            { atMs: 700, text: "Two.", speechFinal: true },
          ],
          latencyMs: 10,
        }),
        mt: new MockMtProvider({ firstTokenMs: 10, msPerToken: 1 }),
        tts: new MockTtsProvider({ firstByteMs: 10, msPerChar: 5, chunkMs: 20 }),
      },
      config: {
        sourceLang: "en",
        targetLang: "hi",
        direction: "inbound",
        inputSampleRate: 16000,
        glossary: [],
      },
      durationMs: 1000,
      speed: 10,
      playbackDelayMs: 50,
    });
    expect(res.segments.map((s) => s.source)).toEqual(["One.", "Two."]);
    expect(res.report.endToEnd?.n).toBe(2);
    expect(res.report.endToEnd?.p50).toBeGreaterThan(50);
    expect(res.report.endToEnd?.p50).toBeLessThan(600);
    expect(formatReport(res.report)).toContain("perceived");
  }, 15000);

  it("gates on regressions", () => {
    const base = { endToEnd: { n: 3, p50: 1000, p95: 1500, max: 1600 } };
    expect(gate({ endToEnd: { n: 3, p50: 1050, p95: 1600, max: 1700 } }, base).ok).toBe(true);
    const bad = gate({ endToEnd: { n: 2, p50: 1200, p95: 1600, max: 1700 } }, base);
    expect(bad.ok).toBe(false);
    expect(bad.reasons).toHaveLength(2);
    expect(gate({}, base).ok).toBe(false);
  });
});
