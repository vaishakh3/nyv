import { describe, expect, it } from "vitest";
import { AudioSequencer } from "./audio-sequencer.js";

describe("AudioSequencer", () => {
  it("releases audio strictly in segment order", () => {
    const log: string[] = [];
    const seq = new AudioSequencer(
      {
        onSegmentStart: (id) => log.push(`start ${id}`),
        onAudio: (id, pcm) => log.push(`audio ${id} ${pcm.length}`),
        onSegmentEnd: (id, ms) => log.push(`end ${id} ${ms}`),
      },
      1000,
    );
    const s1 = seq.open(1);
    const s2 = seq.open(2);
    s2.push(new Int16Array(500));
    s2.end();
    expect(log).toEqual([]);
    s1.push(new Int16Array(250));
    expect(log).toEqual(["start 1", "audio 1 250"]);
    s1.end();
    expect(log).toEqual([
      "start 1",
      "audio 1 250",
      "end 1 250",
      "start 2",
      "audio 2 500",
      "end 2 500",
    ]);
  });

  it("skips segments without audio", () => {
    const log: string[] = [];
    const seq = new AudioSequencer(
      {
        onSegmentStart: (id) => log.push(`start ${id}`),
        onAudio: () => {},
        onSegmentEnd: (id) => log.push(`end ${id}`),
      },
      1000,
    );
    const s2 = seq.open(2);
    s2.push(new Int16Array(10));
    s2.end();
    seq.skip(1);
    expect(log).toEqual(["start 2", "end 2"]);
  });
});
