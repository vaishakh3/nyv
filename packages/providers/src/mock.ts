import {
  type AsrEvent,
  type AsrProvider,
  type AsrStartOptions,
  type AsrStream,
  collect,
  type MtProvider,
  type MtRequest,
  type TtsOptions,
  type TtsProvider,
  wordsFromText,
} from "@nyv/core";
import { tone } from "./pcm.js";

export interface MockScriptLine {
  /** Audio-timeline ms at which the vendor would emit the final for this line. */
  atMs: number;
  text: string;
  speechFinal?: boolean;
}

export interface MockAsrOptions {
  /** Transcript the "vendor" produces as audio arrives, keyed by audio position. Defaults to a demo script. */
  script?: MockScriptLine[];
  /** Simulated vendor processing delay before each event. */
  latencyMs?: number;
  /** Emit word-by-word partials before each final. */
  partials?: boolean;
  /** Words per second used to synthesize word timings. */
  wordsPerSecond?: number;
}

export const DEMO_SCRIPT: MockScriptLine[] = [
  { atMs: 1800, text: "Hi everyone, thanks for joining." },
  { atMs: 4200, text: "I will send you the report tomorrow morning." },
  { atMs: 6600, text: "Does that work for you?", speechFinal: true },
];

/**
 * Mock ASR: watches the amount of audio received and emits scripted partials/finals, so the full
 * pipeline runs and is measurable without a vendor. Audio content is ignored.
 */
export class MockAsrProvider implements AsrProvider {
  readonly name = "mock";
  constructor(private readonly opts: MockAsrOptions = {}) {}

  async start(opts: AsrStartOptions, onEvent: (e: AsrEvent) => void): Promise<AsrStream> {
    const script = [...(this.opts.script ?? DEMO_SCRIPT)].sort((a, b) => a.atMs - b.atMs);
    const latency = this.opts.latencyMs ?? 120;
    const wps = this.opts.wordsPerSecond ?? 3;
    let audioMs = 0;
    let next = 0;
    let closed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!closed) fn();
      }, ms);
      timers.add(t);
    };
    const emitLine = (line: MockScriptLine) => {
      const words = wordsFromText(
        line.text,
        Math.max(0, line.atMs - (line.text.split(/\s+/).length * 1000) / wps),
        1000 / wps,
      );
      if (this.opts.partials ?? true) {
        for (let i = 1; i < words.length; i++) {
          const partial = words.slice(0, i);
          later(
            () =>
              onEvent({
                type: "partial",
                text: partial.map((w) => w.word).join(" "),
                words: partial,
              }),
            latency * (i / words.length),
          );
        }
      }
      later(
        () =>
          onEvent({
            type: "final",
            text: line.text,
            words,
            speechFinal: line.speechFinal ?? false,
          }),
        latency,
      );
    };
    return {
      sendAudio: (pcm) => {
        audioMs += (pcm.length / opts.sampleRate) * 1000;
        while (next < script.length && (script[next] as MockScriptLine).atMs <= audioMs) {
          emitLine(script[next] as MockScriptLine);
          next++;
        }
      },
      finalize: () => {
        later(() => onEvent({ type: "utterance_end", lastWordEndMs: audioMs }), latency);
      },
      close: () => {
        closed = true;
        for (const t of timers) clearTimeout(t);
        onEvent({ type: "closed" });
      },
    };
  }
}

export interface MockMtOptions {
  firstTokenMs?: number;
  msPerToken?: number;
  /** Fixed replacements applied word-by-word; everything else is wrapped to show the target language. */
  dictionary?: Record<string, string>;
}

const HINDI_DEMO: Record<string, string> = {
  hi: "नमस्ते",
  everyone: "सभी को",
  thanks: "धन्यवाद",
  report: "रिपोर्ट",
  tomorrow: "कल",
  morning: "सुबह",
};

export class MockMtProvider implements MtProvider {
  readonly name = "mock";
  constructor(private readonly opts: MockMtOptions = {}) {}

  async translate(
    req: MtRequest,
    onToken: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const dict = this.opts.dictionary ?? (req.targetLang === "hi" ? HINDI_DEMO : {});
    const tokens = req.text.split(/\s+/).map((w) => {
      const key = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const punct = w.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";
      return (dict[key] ?? `${w.replace(/[^\p{L}\p{N}]+$/u, "")}`) + punct;
    });
    await sleep(this.opts.firstTokenMs ?? 180, signal);
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      if (i > 0) await sleep(this.opts.msPerToken ?? 25, signal);
      const tok = `${tokens[i]}${i < tokens.length - 1 ? " " : ""}`;
      out += tok;
      onToken(tok);
    }
    return out;
  }
}

export interface MockTtsOptions {
  sampleRate?: number;
  /** Time to first audio after the first text arrives. */
  firstByteMs?: number;
  /** Speech duration generated per character of text. */
  msPerChar?: number;
  /** Size of each emitted chunk. */
  chunkMs?: number;
  /** When false, waits for all text before producing audio (like a non-streaming vendor). */
  streamingInput?: boolean;
}

export class MockTtsProvider implements TtsProvider {
  readonly name = "mock";
  readonly outputSampleRate: number;
  constructor(private readonly opts: MockTtsOptions = {}) {
    this.outputSampleRate = opts.sampleRate ?? 24000;
  }

  async synthesize(
    text: AsyncIterable<string>,
    _o: TtsOptions,
    onAudio: (pcm: Int16Array) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const firstByte = this.opts.firstByteMs ?? 90;
    const msPerChar = this.opts.msPerChar ?? 55;
    const chunkMs = this.opts.chunkMs ?? 100;
    let started = false;
    let pendingChars = 0;
    const speak = async (chars: number) => {
      if (!started) {
        started = true;
        await sleep(firstByte, signal);
      }
      let remaining = chars * msPerChar;
      while (remaining > 0) {
        const ms = Math.min(chunkMs, remaining);
        onAudio(tone(ms, this.outputSampleRate, 330));
        remaining -= ms;
        // Real vendors produce audio faster than real time; emulate ~4x.
        await sleep(ms / 4, signal);
      }
    };
    if (this.opts.streamingInput ?? true) {
      for await (const chunk of text) {
        pendingChars += chunk.length;
        if (pendingChars >= 12) {
          const n = pendingChars;
          pendingChars = 0;
          await speak(n);
        }
      }
      if (pendingChars > 0) await speak(pendingChars);
    } else {
      const full = await collect(text);
      await speak(full.length);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}
