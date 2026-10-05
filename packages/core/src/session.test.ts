import type { ServerMessage } from "@nyv/protocol";
import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { wordsFromText } from "./segmenter.js";
import { TranslationSession } from "./session.js";
import { collect } from "./text-queue.js";
import type { AsrEvent, AsrProvider, MtProvider, TtsProvider } from "./types.js";

function fakeProviders(opts: { ttsDelayMs?: (text: string) => number } = {}) {
  let emit: ((e: AsrEvent) => void) | undefined;
  const asr: AsrProvider = {
    name: "fake-asr",
    start: async (_o, onEvent) => {
      emit = onEvent;
      return { sendAudio: () => {}, finalize: () => {}, close: () => {} };
    },
  };
  const mt: MtProvider = {
    name: "fake-mt",
    translate: async (req, onToken) => {
      const out = `[${req.targetLang}] ${req.text.toUpperCase()}`;
      for (const tok of out.split(" ")) onToken(`${tok} `);
      return `${out} `;
    },
  };
  const tts: TtsProvider = {
    name: "fake-tts",
    outputSampleRate: 1000,
    synthesize: async (text, _o, onAudio) => {
      const full = await collect(text);
      await new Promise((r) => setTimeout(r, opts.ttsDelayMs?.(full) ?? 0));
      onAudio(new Int16Array(full.length));
    },
  };
  return { providers: { asr, mt, tts }, asrEmit: (e: AsrEvent) => emit?.(e) };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 30));
}

describe("TranslationSession", () => {
  it("runs a segment through transcript → translation → audio → trace", async () => {
    const { providers, asrEmit } = fakeProviders();
    const messages: ServerMessage[] = [];
    const audio: Array<{ id: number; len: number; last: boolean }> = [];
    const clock = new ManualClock(0);
    const session = new TranslationSession(
      {
        sessionId: "s1",
        config: {
          sourceLang: "en",
          targetLang: "hi",
          direction: "inbound",
          inputSampleRate: 16000,
          glossary: [],
        },
        providers,
        clock,
      },
      {
        onMessage: (m) => messages.push(m),
        onAudio: (id, pcm, last) => audio.push({ id, len: pcm.length, last }),
      },
    );
    await session.start();
    expect(messages[0]).toMatchObject({
      type: "session.ready",
      outputSampleRate: 1000,
      providers: { asr: "fake-asr" },
    });

    session.pushAudio(new Int16Array(16000)); // 1 s of audio at t=0
    clock.set(1000);
    asrEmit({
      type: "final",
      text: "",
      words: wordsFromText("Send the report.", 100),
      speechFinal: true,
    });
    await settle();

    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "session.ready",
      "transcript", // progress
      "transcript", // final
      "translation",
      "translation",
      "translation",
      "translation",
      "translation", // final
      "segment.audio.start",
      "segment.audio.end",
      "trace",
    ]);
    const final = messages.find((m) => m.type === "translation" && m.final);
    expect(final).toMatchObject({ segmentId: 1, text: "[hi] SEND THE REPORT. " });
    expect(audio).toEqual([
      { id: 1, len: "[hi] SEND THE REPORT. ".length, last: false },
      { id: 1, len: 0, last: true },
    ]);
    const trace = messages.find((m) => m.type === "trace");
    expect(trace).toMatchObject({
      segmentId: 1,
      hops: { speechEnd: 0, asrFinal: 1000, mtFirstToken: 1000, ttsDone: 1000 },
    });

    session.reportPlayback(1, 1400);
    expect(messages.at(-1)).toMatchObject({ type: "trace", hops: { playbackStart: 1400 } });
    await session.stop();
    expect(messages.at(-1)).toMatchObject({ type: "session.stopped" });
  });

  it("keeps audio ordered when a later segment synthesizes faster", async () => {
    const { providers, asrEmit } = fakeProviders({
      ttsDelayMs: (t) => (t.includes("FIRST") ? 40 : 0),
    });
    const audio: number[] = [];
    const session = new TranslationSession(
      {
        sessionId: "s2",
        config: {
          sourceLang: "en",
          targetLang: "es",
          direction: "inbound",
          inputSampleRate: 16000,
          glossary: [],
        },
        providers,
      },
      {
        onMessage: () => {},
        onAudio: (id, _pcm, last) => {
          if (!last) audio.push(id);
        },
      },
    );
    await session.start();
    asrEmit({
      type: "final",
      text: "",
      words: wordsFromText("First sentence.", 0),
      speechFinal: false,
    });
    asrEmit({
      type: "final",
      text: "",
      words: wordsFromText("Second sentence.", 1000),
      speechFinal: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(audio).toEqual([1, 2]);
    await session.stop();
  });

  it("reports a non-fatal error when translation fails and moves on", async () => {
    const { providers, asrEmit } = fakeProviders();
    providers.mt = {
      name: "broken",
      translate: async () => {
        throw new Error("quota");
      },
    };
    const messages: ServerMessage[] = [];
    const session = new TranslationSession(
      {
        sessionId: "s3",
        config: {
          sourceLang: "en",
          targetLang: "hi",
          direction: "inbound",
          inputSampleRate: 16000,
          glossary: [],
        },
        providers,
      },
      { onMessage: (m) => messages.push(m), onAudio: () => {} },
    );
    await session.start();
    asrEmit({ type: "final", text: "", words: wordsFromText("Oops.", 0), speechFinal: true });
    await settle();
    expect(messages.find((m) => m.type === "error")).toMatchObject({
      code: "provider_failed",
      fatal: false,
      message: "quota",
    });
    await session.stop();
    expect(session.state).toBe("stopped");
  });
});
