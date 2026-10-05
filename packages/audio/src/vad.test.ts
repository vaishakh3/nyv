import { describe, expect, it } from "vitest";
import { catchUpRate } from "./catch-up.js";
import { Ducker } from "./ducker.js";
import { EnergyVad } from "./vad.js";

const silence = () => Float32Array.from({ length: 320 }, () => (Math.random() - 0.5) * 0.002);
const speech = () => Float32Array.from({ length: 320 }, (_, i) => Math.sin(i / 3) * 0.3);

describe("EnergyVad", () => {
  it("fires start after minSpeech and end after hangover", () => {
    const vad = new EnergyVad({
      thresholdDb: 9,
      hangoverMs: 300,
      minSpeechMs: 60,
      floorAdapt: 0.1,
    });
    const events: string[] = [];
    let t = 0;
    for (let i = 0; i < 50; i++, t += 20) events.push(vad.process(silence(), t) ?? "");
    for (let i = 0; i < 20; i++, t += 20) events.push(vad.process(speech(), t) ?? "");
    for (let i = 0; i < 30; i++, t += 20) events.push(vad.process(silence(), t) ?? "");
    const fired = events.filter(Boolean);
    expect(fired).toEqual(["speechStart", "speechEnd"]);
    const startIdx = events.indexOf("speechStart");
    expect(startIdx).toBeGreaterThanOrEqual(53); // ≥ 60 ms after speech begins at frame 50
    const endIdx = events.indexOf("speechEnd");
    expect(endIdx).toBeGreaterThanOrEqual(70 + 15);
  });
});

describe("Ducker", () => {
  it("holds the duck across short gaps", () => {
    const d = new Ducker({ duckedGain: 0.1, attackMs: 50, releaseMs: 200, holdMs: 400 });
    expect(d.target(0).gain).toBe(1);
    d.active(1000);
    expect(d.target(1300)).toEqual({ gain: 0.1, rampMs: 50 });
    expect(d.target(1500)).toEqual({ gain: 1, rampMs: 200 });
  });
});

describe("catchUpRate", () => {
  it("ramps between comfort and panic", () => {
    const o = { comfortMs: 500, panicMs: 2500, maxRate: 1.4 };
    expect(catchUpRate(100, o)).toBe(1);
    expect(catchUpRate(1500, o)).toBeCloseTo(1.2);
    expect(catchUpRate(9999, o)).toBe(1.4);
  });
});
