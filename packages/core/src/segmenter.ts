import type { Clock } from "./clock.js";
import { LocalAgreement } from "./local-agreement.js";
import type { AsrEvent, AsrWord } from "./types.js";

export interface Segment {
  id: number;
  text: string;
  words: AsrWord[];
  /** Audio-timeline ms of the last word. */
  speechEndMs: number;
  speechStartMs: number;
}

export interface SegmenterOptions {
  /** Hypotheses that must agree before a word is committed. */
  agreement?: number;
  /** Close a segment at a soft boundary (, ; :) once it has at least this many words. */
  softBoundaryMinWords?: number;
  /** Close a segment after this much audio even without punctuation. */
  maxSegmentMs?: number;
  /** Hold a short committed tail this long waiting for more words before closing on a pause. */
  pauseFlushMs?: number;
}

export interface SegmenterEvents {
  /** The open segment changed (committed prefix grew or unstable tail changed). */
  onProgress(seg: { id: number; committed: string; text: string }): void;
  /** A segment closed and is ready for translation. */
  onSegment(seg: Segment): void;
}

const HARD = /[.!?।？！]$/u; // includes Devanagari danda and full-width marks
const SOFT = /[,;:，、]$/u;

/**
 * Turns a stream of ASR events into translation units ("segments").
 *
 * A segment closes when the committed text ends in sentence punctuation, at a soft boundary once the
 * segment is long enough, when the vendor or the client reports end of speech, or when it has grown
 * past maxSegmentMs. Unstable words are only ever shown as captions; they never reach translation.
 */
export class Segmenter {
  private readonly la: LocalAgreement;
  private readonly opts: Required<SegmenterOptions>;
  private committedWords: AsrWord[] = [];
  private unstable: AsrWord[] = [];
  private nextId = 1;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly events: SegmenterEvents,
    readonly clock: Clock,
    opts: SegmenterOptions = {},
  ) {
    this.opts = {
      agreement: opts.agreement ?? 2,
      softBoundaryMinWords: opts.softBoundaryMinWords ?? 7,
      maxSegmentMs: opts.maxSegmentMs ?? 6000,
      pauseFlushMs: opts.pauseFlushMs ?? 700,
    };
    this.la = new LocalAgreement(this.opts.agreement);
  }

  get currentId(): number {
    return this.nextId;
  }

  handle(event: AsrEvent): void {
    switch (event.type) {
      case "partial": {
        const words = this.unemitted(event.words);
        const fresh = this.la.push(words.map((w) => w.word));
        const committedNow = this.la.committed;
        this.committedWords.push(...words.slice(committedNow - fresh.length, committedNow));
        this.unstable = words.slice(committedNow);
        this.afterCommit();
        break;
      }
      case "final": {
        const words = this.unemitted(event.words);
        this.la.finalize(words.map((w) => w.word));
        // Replace whatever partial words we had for this chunk with the vendor's final ones.
        const chunkStart = this.committedChunkStart;
        this.committedWords = [...this.committedWords.slice(0, chunkStart), ...words];
        this.committedChunkStart = this.committedWords.length;
        this.unstable = [];
        this.afterCommit();
        if (event.speechFinal) this.flush();
        break;
      }
      case "utterance_end":
        this.flush();
        break;
      case "error":
      case "closed":
        this.flush(true);
        break;
    }
  }

  /** Index into committedWords where the current (unfinalized) ASR chunk begins. */
  private committedChunkStart = 0;
  /** Audio time up to which words have already been shipped in a segment, and the last word shipped. */
  private emittedUntilMs = 0;
  private lastEmittedWord = "";

  /**
   * Vendors re-send the whole chunk (partials and the final alike) even after we closed a segment in
   * the middle of it; drop the words we have already translated. Interim timings for the last word of
   * a hypothesis are truncated (the word was still being spoken), so besides the time overlap test we
   * also drop a leading word that repeats the last shipped word within a word's length of it.
   */
  private unemitted(words: readonly AsrWord[]): AsrWord[] {
    if (!this.lastEmittedWord) return [...words];
    let i = 0;
    while (i < words.length) {
      const w = words[i] as AsrWord;
      const overlaps = w.startMs + 40 < this.emittedUntilMs;
      // Every earlier word was dropped, so this is the chunk's first surviving word.
      const repeats =
        w.startMs < this.emittedUntilMs + 400 && normalize(w.word) === this.lastEmittedWord;
      if (!overlaps && !repeats) break;
      i++;
    }
    return i === 0 ? [...words] : words.slice(i);
  }

  /** Client-side VAD saw silence. */
  speechEnded(): void {
    this.flush();
  }

  /**
   * Force-close the open segment, if any. The unstable tail is normally dropped rather than translated
   * as a guess; pass `includeUnstable` when no better hypothesis can arrive (stream ended).
   */
  flush(includeUnstable = false): void {
    this.clearPauseTimer();
    if (includeUnstable && this.unstable.length > 0) {
      this.committedWords = [...this.committedWords, ...this.unstable];
      this.unstable = [];
    }
    if (this.committedWords.length === 0) {
      this.unstable = [];
      return;
    }
    const words = this.committedWords;
    this.committedWords = [];
    this.committedChunkStart = 0;
    this.unstable = [];
    this.la.reset();
    const last = words[words.length - 1] as AsrWord;
    const first = words[0] as AsrWord;
    this.emittedUntilMs = Math.max(this.emittedUntilMs, last.endMs);
    this.lastEmittedWord = normalize(last.word);
    this.events.onSegment({
      id: this.nextId++,
      text: joinWords(words),
      words,
      speechStartMs: first.startMs,
      speechEndMs: last.endMs,
    });
  }

  dispose(): void {
    this.clearPauseTimer();
  }

  private afterCommit(): void {
    this.events.onProgress({
      id: this.nextId,
      committed: joinWords(this.committedWords),
      text: joinWords([...this.committedWords, ...this.unstable]),
    });
    if (this.committedWords.length === 0) return;

    const last = this.committedWords[this.committedWords.length - 1] as AsrWord;
    const first = this.committedWords[0] as AsrWord;
    const hard = HARD.test(last.word);
    const soft =
      SOFT.test(last.word) && this.committedWords.length >= this.opts.softBoundaryMinWords;
    const tooLong = last.endMs - first.startMs >= this.opts.maxSegmentMs;

    // Only cut at a boundary when the next word has not already been committed past it.
    if ((hard || soft) && this.unstable.length === 0) {
      this.flush();
      return;
    }
    if (tooLong) {
      this.flushUpToBoundary();
      return;
    }
    this.armPauseTimer();
  }

  /** On overflow, prefer cutting at the last soft boundary inside the segment. */
  private flushUpToBoundary(): void {
    let cut = this.committedWords.length;
    for (
      let i = this.committedWords.length - 2;
      i >= Math.floor(this.committedWords.length / 2);
      i--
    ) {
      const w = (this.committedWords[i] as AsrWord).word;
      if (HARD.test(w) || SOFT.test(w)) {
        cut = i + 1;
        break;
      }
    }
    const rest = this.committedWords.slice(cut);
    const restChunkStart = Math.max(0, this.committedChunkStart - cut);
    this.committedWords = this.committedWords.slice(0, cut);
    const unstable = this.unstable;
    this.flush();
    this.committedWords = rest;
    this.committedChunkStart = restChunkStart;
    this.unstable = unstable;
  }

  private armPauseTimer(): void {
    this.clearPauseTimer();
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined;
      // If no new words arrived for a while, the speaker paused: ship what we have.
      if (this.committedWords.length > 0 && this.unstable.length === 0) this.flush();
    }, this.opts.pauseFlushMs);
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== undefined) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
    }
  }
}

const normalize = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function joinWords(words: readonly AsrWord[]): string {
  return words
    .map((w) => w.word)
    .join(" ")
    .replace(/\s+([,.!?;:।])/gu, "$1")
    .trim();
}

export function wordsFromText(text: string, startMs: number, msPerWord = 300): AsrWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({
      word,
      startMs: startMs + i * msPerWord,
      endMs: startMs + (i + 1) * msPerWord,
    }));
}
