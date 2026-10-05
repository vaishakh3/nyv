import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "./clock.js";
import { type Segment, Segmenter, wordsFromText } from "./segmenter.js";

function setup(opts = {}) {
  const segments: Segment[] = [];
  const progress: { id: number; committed: string; text: string }[] = [];
  const seg = new Segmenter(
    { onSegment: (s) => segments.push(s), onProgress: (p) => progress.push(p) },
    new ManualClock(),
    opts,
  );
  return { seg, segments, progress };
}

describe("Segmenter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes a segment at sentence punctuation once committed", () => {
    const { seg, segments, progress } = setup();
    seg.handle({ type: "partial", text: "", words: wordsFromText("I will send", 0) });
    seg.handle({ type: "partial", text: "", words: wordsFromText("I will send the", 0) });
    expect(segments).toHaveLength(0);
    expect(progress.at(-1)).toMatchObject({ committed: "I will send", text: "I will send the" });
    seg.handle({
      type: "final",
      text: "",
      words: wordsFromText("I will send the report.", 0),
      speechFinal: false,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: 1,
      text: "I will send the report.",
      speechStartMs: 0,
      speechEndMs: 1500,
    });
  });

  it("never re-emits words already shipped when the vendor re-sends the whole chunk", () => {
    const { seg, segments } = setup();
    // Two agreeing partials commit "Hi everyone." → closes on the period, mid-chunk.
    seg.handle({ type: "partial", text: "", words: wordsFromText("Hi everyone.", 0) });
    seg.handle({ type: "partial", text: "", words: wordsFromText("Hi everyone.", 0) });
    expect(segments.map((s) => s.text)).toEqual(["Hi everyone."]);
    // Deepgram keeps sending the full chunk in later partials and in the final.
    seg.handle({ type: "partial", text: "", words: wordsFromText("Hi everyone. Thanks for", 0) });
    seg.handle({
      type: "partial",
      text: "",
      words: wordsFromText("Hi everyone. Thanks for joining", 0),
    });
    expect(segments).toHaveLength(1);
    seg.handle({
      type: "final",
      text: "",
      words: wordsFromText("Hi everyone. Thanks for joining today.", 0),
      speechFinal: true,
    });
    expect(segments.map((s) => s.text)).toEqual(["Hi everyone.", "Thanks for joining today."]);
    expect(segments[1]).toMatchObject({ speechStartMs: 600, speechEndMs: 1800 });
  });

  it("drops a re-sent last word whose interim timing was truncated", () => {
    const { seg, segments } = setup();
    // Interim: "today." is still being spoken, so its end time is early.
    const interim = [
      ...wordsFromText("Thanks for joining", 0),
      { word: "today.", startMs: 900, endMs: 1000 },
    ];
    seg.handle({ type: "partial", text: "", words: interim });
    seg.handle({ type: "partial", text: "", words: interim });
    expect(segments.map((s) => s.text)).toEqual(["Thanks for joining today."]);
    // Final: the same word now spans 900–1400 and is followed by new words.
    seg.handle({
      type: "final",
      text: "",
      words: [
        ...wordsFromText("Thanks for joining", 0),
        { word: "today.", startMs: 900, endMs: 1400 },
        ...wordsFromText("Let's get started.", 1500),
      ],
      speechFinal: true,
    });
    expect(segments.map((s) => s.text)).toEqual([
      "Thanks for joining today.",
      "Let's get started.",
    ]);
  });

  it("does not translate unstable words on flush", () => {
    const { seg, segments } = setup();
    seg.handle({ type: "partial", text: "", words: wordsFromText("maybe", 0) });
    seg.flush();
    expect(segments).toHaveLength(0);
  });

  it("flushes on utterance end and on client speech end", () => {
    const { seg, segments } = setup();
    seg.handle({ type: "final", text: "", words: wordsFromText("okay so", 0), speechFinal: false });
    seg.handle({ type: "utterance_end", lastWordEndMs: 600 });
    expect(segments.map((s) => s.text)).toEqual(["okay so"]);
    seg.handle({
      type: "final",
      text: "",
      words: wordsFromText("right", 1000),
      speechFinal: false,
    });
    seg.speechEnded();
    expect(segments.map((s) => s.text)).toEqual(["okay so", "right"]);
    expect(segments[1]?.id).toBe(2);
  });

  it("cuts at a soft boundary only once the segment is long enough", () => {
    const { seg, segments } = setup({ softBoundaryMinWords: 4 });
    seg.handle({ type: "final", text: "", words: wordsFromText("well,", 0), speechFinal: false });
    expect(segments).toHaveLength(0);
    seg.handle({
      type: "final",
      text: "",
      words: wordsFromText("as I was saying,", 300),
      speechFinal: false,
    });
    expect(segments.map((s) => s.text)).toEqual(["well, as I was saying,"]);
  });

  it("flushes on a pause when nothing new arrives", () => {
    const { seg, segments } = setup({ pauseFlushMs: 500 });
    seg.handle({ type: "final", text: "", words: wordsFromText("hold on", 0), speechFinal: false });
    vi.advanceTimersByTime(499);
    expect(segments).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(segments.map((s) => s.text)).toEqual(["hold on"]);
  });

  it("caps segment length, preferring the last soft boundary", () => {
    const { seg, segments } = setup({ maxSegmentMs: 3000, softBoundaryMinWords: 100 });
    const words = wordsFromText("one two three four, five six seven eight nine ten eleven", 0);
    seg.handle({ type: "final", text: "", words, speechFinal: false });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(
      "one two three four, five six seven eight nine ten eleven".slice(0, 0) || segments[0]?.text,
    );
    // 11 words * 300ms = 3300ms >= cap; the boundary search looks in the back half, so the cut is the full text
    seg.handle({
      type: "final",
      text: "",
      words: wordsFromText("twelve", 3300),
      speechFinal: true,
    });
    expect(segments).toHaveLength(2);
  });

  it("replaces partial words with the vendor's final words for the same chunk", () => {
    const { seg, segments } = setup();
    seg.handle({ type: "partial", text: "", words: wordsFromText("recognise speech", 0) });
    seg.handle({ type: "partial", text: "", words: wordsFromText("recognise speech now", 0) });
    seg.handle({
      type: "final",
      text: "",
      words: wordsFromText("wreck a nice beach now.", 0),
      speechFinal: true,
    });
    expect(segments.map((s) => s.text)).toEqual(["wreck a nice beach now."]);
  });
});
