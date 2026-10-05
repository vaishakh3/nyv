import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { durations, percentiles, summarize, Tracer } from "./tracer.js";

describe("Tracer", () => {
  it("keeps the first timestamp for a hop", () => {
    const clock = new ManualClock(100);
    const t = new Tracer(clock);
    t.mark(1, "ttsFirstByte");
    clock.advance(50);
    t.mark(1, "ttsFirstByte");
    expect(t.get(1)?.ttsFirstByte).toBe(100);
  });

  it("derives hop durations", () => {
    expect(
      durations({
        speechEnd: 1000,
        asrFinal: 1300,
        mtFirstToken: 1550,
        mtDone: 1900,
        ttsFirstByte: 1700,
        playbackStart: 1850,
      }),
    ).toEqual({
      endToEnd: 850,
      asr: 300,
      mtFirstToken: 250,
      mt: 600,
      ttsFirstByte: 150,
      transport: 150,
    });
    expect(durations({ speechEnd: 1 })).toEqual({});
  });

  it("summarizes percentiles", () => {
    expect(percentiles([5, 1, 3])).toEqual({ n: 3, p50: 3, p95: 5, max: 5 });
    expect(percentiles([])).toBeUndefined();
    const r = summarize([
      { speechEnd: 0, playbackStart: 1000 },
      { speechEnd: 0, playbackStart: 2000 },
      { speechEnd: 0 },
    ]);
    expect(r.endToEnd).toEqual({ n: 2, p50: 2000, p95: 2000, max: 2000 });
  });
});
