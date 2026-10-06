import { collect, TextQueue } from "@fyv/core";
import { describe, expect, it } from "vitest";
import { MockAsrProvider, MockMtProvider, MockTtsProvider } from "./mock.js";

describe("mock providers", () => {
  it("ASR emits scripted finals as audio accumulates", async () => {
    const events: string[] = [];
    const asr = new MockAsrProvider({
      script: [{ atMs: 500, text: "hello there." }],
      latencyMs: 1,
      partials: true,
    });
    const stream = await asr.start({ language: "en", sampleRate: 16000 }, (e) =>
      events.push(e.type),
    );
    stream.sendAudio(new Int16Array(16000 * 0.4));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([]);
    stream.sendAudio(new Int16Array(16000 * 0.2));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["partial", "final"]);
    stream.close();
    expect(events.at(-1)).toBe("closed");
  });

  it("MT streams tokens and applies the demo dictionary", async () => {
    const mt = new MockMtProvider({ firstTokenMs: 0, msPerToken: 0 });
    const tokens: string[] = [];
    const out = await mt.translate(
      {
        text: "Thanks everyone.",
        sourceLang: "en",
        targetLang: "hi",
        context: { history: [], glossary: [] },
      },
      (t) => tokens.push(t),
    );
    expect(out).toBe("धन्यवाद सभी को.");
    expect(tokens.join("")).toBe(out);
  });

  it("TTS produces audio proportional to text length", async () => {
    const tts = new MockTtsProvider({
      firstByteMs: 0,
      msPerChar: 10,
      chunkMs: 50,
      sampleRate: 8000,
    });
    const q = new TextQueue();
    const chunks: number[] = [];
    const done = tts.synthesize(q, { language: "hi" }, (pcm) => chunks.push(pcm.length));
    q.push("twenty characters!!!");
    q.close();
    await done;
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(8000 * 0.2);
    expect(
      await collect(
        (async function* () {
          yield "x";
        })(),
      ),
    ).toBe("x");
  });
});
