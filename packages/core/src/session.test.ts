import type { ServerMessage, SessionConfig } from "@nyv/protocol";
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

  const cfg: SessionConfig = {
    sourceLang: "en",
    targetLang: "hi",
    direction: "inbound",
    inputSampleRate: 16000,
    glossary: [],
  };

  function spyMt(providers: ReturnType<typeof fakeProviders>["providers"]): string[] {
    const calls: string[] = [];
    const inner = providers.mt;
    providers.mt = {
      name: "spy-mt",
      translate: (req, onToken, signal) => {
        calls.push(req.text);
        return inner.translate(req, onToken, signal);
      },
    };
    return calls;
  }

  it("adopts a speculative translation when the final transcript matches the hypothesis", async () => {
    const { providers, asrEmit } = fakeProviders();
    const calls = spyMt(providers);
    const warmed: string[] = [];
    providers.tts.warm = (o) => warmed.push(o.language);
    const messages: ServerMessage[] = [];
    const clock = new ManualClock(0);
    const session = new TranslationSession(
      {
        sessionId: "s3",
        config: cfg,
        providers,
        clock,
        speculative: true,
        speculationDebounceMs: 0,
      },
      { onMessage: (m) => messages.push(m), onAudio: () => {} },
    );
    await session.start();
    const words = wordsFromText("see you tomorrow", 0);
    asrEmit({ type: "partial", text: "see you tomorrow", words });
    asrEmit({ type: "partial", text: "see you tomorrow", words });
    await settle();
    expect(calls).toEqual(["see you tomorrow"]);
    expect(warmed).toEqual(["hi"]);
    clock.advance(400);
    asrEmit({
      type: "final",
      text: "See you tomorrow.",
      words: wordsFromText("See you tomorrow.", 0),
      speechFinal: true,
    });
    await settle();
    expect(calls).toEqual(["see you tomorrow"]);
    expect(session.speculationHits).toBe(1);
    const final = messages.find((m) => m.type === "translation" && m.final);
    expect(final?.type === "translation" && final.text).toContain("SEE YOU TOMORROW");
    const trace = messages.find((m) => m.type === "trace");
    if (trace?.type !== "trace") throw new Error("no trace");
    expect(trace.hops.mtStart).toBeLessThan(trace.hops.asrFinal ?? 0);
    await session.stop();
  });

  it("discards a speculation when the final transcript differs and translates afresh", async () => {
    const { providers, asrEmit } = fakeProviders();
    const calls = spyMt(providers);
    const messages: ServerMessage[] = [];
    const session = new TranslationSession(
      {
        sessionId: "s4",
        config: cfg,
        providers,
        clock: new ManualClock(0),
        speculative: true,
        speculationDebounceMs: 0,
      },
      { onMessage: (m) => messages.push(m), onAudio: () => {} },
    );
    await session.start();
    const words = wordsFromText("does that work", 0);
    asrEmit({ type: "partial", text: "does that work", words });
    await settle();
    asrEmit({
      type: "final",
      text: "Does that work for you?",
      words: wordsFromText("Does that work for you?", 0),
      speechFinal: true,
    });
    await settle();
    expect(calls).toEqual(["does that work", "Does that work for you?"]);
    expect(session.speculationMisses).toBe(1);
    const final = messages.find((m) => m.type === "translation" && m.final);
    expect(final?.type === "translation" && final.text).toContain("DOES THAT WORK FOR YOU?");
    await session.stop();
  });

  it("reconnects the ASR stream when the vendor socket drops, re-basing word times", async () => {
    let starts = 0;
    const emitters: Array<(e: AsrEvent) => void> = [];
    const sent: number[][] = [];
    const asr: AsrProvider = {
      name: "flaky-asr",
      start: async (_o, onEvent) => {
        starts++;
        emitters.push(onEvent);
        const mine: number[] = [];
        sent.push(mine);
        return { sendAudio: (pcm) => mine.push(pcm.length), finalize: () => {}, close: () => {} };
      },
    };
    const { providers } = fakeProviders();
    const messages: ServerMessage[] = [];
    const clock = new ManualClock(0);
    const session = new TranslationSession(
      {
        sessionId: "s-reconnect",
        config: {
          sourceLang: "en",
          targetLang: "hi",
          direction: "inbound",
          inputSampleRate: 16000,
          glossary: [],
        },
        providers: { ...providers, asr },
        clock,
      },
      { onMessage: (m) => messages.push(m), onAudio: () => {} },
    );
    await session.start();
    session.pushAudio(new Int16Array(32000)); // 2 s
    clock.set(2000);
    (emitters[0] as (e: AsrEvent) => void)({ type: "closed" });
    // Audio arriving while the socket is down is buffered, then replayed on the new stream.
    session.pushAudio(new Int16Array(8000));
    await settle();
    expect(starts).toBe(2);
    expect(session.asrRestarts).toBe(1);
    expect(sent[1]).toEqual([8000]);
    expect(messages.find((m) => m.type === "error")).toMatchObject({ fatal: false });

    // New stream's clock starts at 0 = 2 s into the session.
    clock.set(3000);
    const words = wordsFromText("Hello there.", 100);
    (emitters[1] as (e: AsrEvent) => void)({ type: "partial", text: "", words });
    (emitters[1] as (e: AsrEvent) => void)({ type: "final", text: "", words, speechFinal: true });
    await settle();
    const final = messages.find((m) => m.type === "transcript" && m.final);
    expect(final).toMatchObject({ text: "Hello there." });
    const trace = messages.find((m) => m.type === "trace");
    // Word at 100 ms on the new stream = 2100 ms on the session timeline, which arrived at clock 2000.
    expect(trace?.type === "trace" && trace.hops.speechStart).toBeGreaterThanOrEqual(2000);
    await session.stop();
  });

  it("asks TTS for a faster voice while the listener is behind, and natural speed once caught up", async () => {
    const { providers, asrEmit } = fakeProviders();
    const speeds: Array<number | undefined> = [];
    const tts: TtsProvider = {
      ...providers.tts,
      synthesize: async (text, o, onAudio) => {
        speeds.push(o.speed);
        await collect(text);
        onAudio(new Int16Array(10));
      },
    };
    const clock = new ManualClock(0);
    const session = new TranslationSession(
      {
        sessionId: "s-speed",
        config: {
          sourceLang: "en",
          targetLang: "hi",
          direction: "inbound",
          inputSampleRate: 16000,
          glossary: [],
        },
        providers: { ...providers, tts },
        clock,
      },
      { onMessage: () => {}, onAudio: () => {} },
    );
    await session.start();
    const say = (text: string, at: number) => {
      const words = wordsFromText(text, at);
      asrEmit({ type: "final", text, words, speechFinal: true });
    };
    say("One.", 0);
    await settle();
    session.reportPlayback(1, 500, 3600);
    say("Two.", 1000);
    await settle();
    session.reportPlayback(2, 1500, 0);
    say("Three.", 2000);
    await settle();
    expect(speeds).toEqual([undefined, 1.15, undefined]);
    await session.stop();
  });
});
