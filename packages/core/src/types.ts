import type { LanguageCode } from "@fyv/protocol";

// ---------------- ASR ----------------

export interface AsrWord {
  word: string;
  /** Audio-timeline milliseconds, relative to the first sample sent on this stream. */
  startMs: number;
  endMs: number;
}

export type AsrEvent =
  /** Interim hypothesis for the current (not yet finalized) chunk. Replaces the previous partial. */
  | { type: "partial"; text: string; words: AsrWord[] }
  /** The current chunk is final; subsequent partials describe new audio. */
  | { type: "final"; text: string; words: AsrWord[]; speechFinal: boolean }
  /** Vendor endpointing says the speaker stopped. */
  | { type: "utterance_end"; lastWordEndMs: number }
  | { type: "error"; error: Error }
  | { type: "closed" };

export interface AsrStream {
  sendAudio(pcm: Int16Array): void;
  /** Ask the vendor to finalize whatever it is holding (client VAD saw silence). */
  finalize(): void;
  close(): void;
}

export interface AsrStartOptions {
  language: LanguageCode;
  sampleRate: number;
}

export interface AsrProvider {
  readonly name: string;
  start(opts: AsrStartOptions, onEvent: (event: AsrEvent) => void): Promise<AsrStream>;
}

// ---------------- MT ----------------

export interface GlossaryEntry {
  term: string;
  translation: string;
}

export interface MtContext {
  /** Most recent first-to-last source/target pairs for coherence. */
  history: ReadonlyArray<{ source: string; target: string }>;
  glossary: ReadonlyArray<GlossaryEntry>;
}

export interface MtRequest {
  text: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  context: MtContext;
}

export interface MtProvider {
  readonly name: string;
  /** Optional: open the HTTP connection ahead of the first request so it skips DNS/TLS. */
  warm?(): void;
  /** Streams target-language tokens through onToken and resolves with the full translation. */
  translate(
    req: MtRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;
}

// ---------------- TTS ----------------

export interface TtsOptions {
  language: LanguageCode;
  voice?: string;
  /** Speaking-rate multiplier (1 = natural). The session raises it slightly when the listener is behind. */
  speed?: number;
}

export interface TtsProvider {
  readonly name: string;
  readonly outputSampleRate: number;
  /** Optional: pre-open a connection so the next synthesize() skips the handshake. */
  warm?(opts: TtsOptions): void;
  /**
   * Synthesizes streaming text. Implementations that accept streaming input start speaking before the
   * translation is complete; others may buffer until the iterable ends.
   */
  synthesize(
    text: AsyncIterable<string>,
    opts: TtsOptions,
    onAudio: (pcm: Int16Array) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface Providers {
  asr: AsrProvider;
  mt: MtProvider;
  tts: TtsProvider;
}
