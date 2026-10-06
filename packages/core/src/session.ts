import type { LanguageCode, ServerMessage, SessionConfig } from "@fyv/protocol";
import { AudioSequencer } from "./audio-sequencer.js";
import { AudioTimeline } from "./audio-timeline.js";
import { type Clock, SessionClock } from "./clock.js";
import { ContextWindow } from "./context-window.js";
import { type Segment, Segmenter, type SegmenterOptions } from "./segmenter.js";
import { TextQueue } from "./text-queue.js";
import { Tracer } from "./tracer.js";
import type { AsrEvent, AsrStream, AsrWord, Providers } from "./types.js";

export type SessionState = "idle" | "starting" | "active" | "stopping" | "stopped";

export interface SessionHandlers {
  onMessage(message: ServerMessage): void;
  /** Translated PCM for a segment at providers.tts.outputSampleRate. `last` carries an empty buffer. */
  onAudio(segmentId: number, pcm: Int16Array, last: boolean): void;
}

export interface SessionOptions {
  sessionId: string;
  config: SessionConfig;
  providers: Providers;
  clock?: Clock;
  segmenter?: SegmenterOptions;
  /**
   * Translate stable partial hypotheses before the segment closes, adopting the result when the final
   * transcript matches. Only pays off with ASR vendors whose last interim equals the final (Deepgram
   * nova-3 emits interims ~1 s apart, so the closing words first appear in the final itself → off by default).
   */
  speculative?: boolean;
  /** Wait this long after the hypothesis last changed before speculating on it. */
  speculationDebounceMs?: number;
}

/** An MT request fired on a partial hypothesis; adopted if the final text matches, else aborted. */
interface Speculation {
  segmentId: number;
  text: string;
  startedAt: number;
  tokens: string[];
  sink: ((token: string) => void) | undefined;
  failed: boolean;
  result: Promise<string>;
  abort: AbortController;
}

/**
 * One translation session: audio in, translated audio + captions + traces out.
 * Owns the ASR stream, the segmenter, and one concurrent MT→TTS job per closed segment.
 */
export class TranslationSession {
  readonly id: string;
  readonly clock: Clock;
  readonly tracer: Tracer;
  private readonly cfg: SessionConfig;
  private readonly providers: Providers;
  private readonly segmenter: Segmenter;
  private readonly timeline: AudioTimeline;
  private readonly context: ContextWindow;
  private readonly sequencer: AudioSequencer;
  private readonly inflight = new Set<Promise<void>>();
  private asr: AsrStream | undefined;
  private _state: SessionState = "idle";
  /** Audio that arrived while the ASR socket was opening or reconnecting; replayed once it is up. */
  private pendingAudio: Int16Array[] = [];
  private pendingSamples = 0;
  /** Word times from the current ASR stream are relative to its first sample; this maps them onto the session timeline. */
  private asrOffsetMs = 0;
  private asrGeneration = 0;
  asrRestarts = 0;
  private readonly speculative: boolean;
  private readonly speculationDebounceMs: number;
  private speculation: Speculation | undefined;
  private speculationTimer: ReturnType<typeof setTimeout> | undefined;
  /** Segments whose translation was adopted from a speculation (for the bench/report). */
  speculationHits = 0;
  speculationMisses = 0;

  constructor(
    opts: SessionOptions,
    private readonly handlers: SessionHandlers,
  ) {
    this.id = opts.sessionId;
    this.cfg = opts.config;
    this.providers = opts.providers;
    this.clock = opts.clock ?? new SessionClock();
    this.tracer = new Tracer(this.clock);
    this.timeline = new AudioTimeline(this.cfg.inputSampleRate);
    this.context = new ContextWindow(this.cfg.glossary);
    this.speculative = opts.speculative ?? false;
    this.speculationDebounceMs = opts.speculationDebounceMs ?? 120;
    this.sequencer = new AudioSequencer(
      {
        onSegmentStart: (segmentId) => this.emit({ type: "segment.audio.start", segmentId }),
        onAudio: (segmentId, pcm) => this.handlers.onAudio(segmentId, pcm, false),
        onSegmentEnd: (segmentId, durationMs) => {
          this.handlers.onAudio(segmentId, new Int16Array(0), true);
          this.emit({ type: "segment.audio.end", segmentId, durationMs });
        },
      },
      this.providers.tts.outputSampleRate,
    );
    this.segmenter = new Segmenter(
      {
        onProgress: ({ id, committed, text }) => {
          this.emit({ type: "transcript", segmentId: id, text, committed, final: false });
          if (committed.length > 0) this.warmTts();
          this.scheduleSpeculation(id, text);
        },
        onSegment: (seg) => this.onSegment(seg),
      },
      this.clock,
      opts.segmenter ?? {},
    );
  }

  get state(): SessionState {
    return this._state;
  }

  get sourceLang(): LanguageCode {
    return this.cfg.sourceLang as LanguageCode;
  }
  get targetLang(): LanguageCode {
    return this.cfg.targetLang as LanguageCode;
  }

  async start(): Promise<void> {
    if (this._state !== "idle") throw new Error(`cannot start from state ${this._state}`);
    this._state = "starting";
    this.providers.mt.warm?.();
    try {
      await this.openAsr();
    } catch (err) {
      this._state = "stopped";
      this.emit({ type: "error", code: "provider_failed", message: describe(err), fatal: true });
      throw err;
    }
    this._state = "active";
    this.replayPending();
    this.emit({
      type: "session.ready",
      sessionId: this.id,
      outputSampleRate: this.providers.tts.outputSampleRate,
      providers: {
        asr: this.providers.asr.name,
        mt: this.providers.mt.name,
        tts: this.providers.tts.name,
      },
    });
  }

  pushAudio(pcm: Int16Array): void {
    if (this._state !== "starting" && this._state !== "active") return;
    this.timeline.record(pcm.length, this.clock.now());
    if (!this.asr) {
      this.pendingAudio.push(pcm);
      this.pendingSamples += pcm.length;
      // Keep at most ~15 s while the vendor is away; older audio would arrive too late to matter.
      while (this.pendingSamples > this.cfg.inputSampleRate * 15 && this.pendingAudio.length > 1) {
        this.pendingSamples -= (this.pendingAudio.shift() as Int16Array).length;
      }
      return;
    }
    this.asr.sendAudio(pcm);
  }

  private async openAsr(): Promise<void> {
    const gen = ++this.asrGeneration;
    const stream = await this.providers.asr.start(
      { language: this.sourceLang, sampleRate: this.cfg.inputSampleRate },
      (e) => this.onAsrEvent(e, gen),
    );
    if (gen !== this.asrGeneration || this._state === "stopping" || this._state === "stopped") {
      stream.close();
      return;
    }
    this.asr = stream;
  }

  private replayPending(): void {
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingSamples = 0;
    for (const pcm of pending) this.asr?.sendAudio(pcm);
  }

  /**
   * The vendor socket dropped mid-call. Ship what we had, buffer incoming audio, reopen with backoff and
   * re-base word times so segments stay on one timeline. Three failures in a row end the session.
   */
  private async reconnectAsr(reason: string): Promise<void> {
    this.asr?.close();
    this.asr = undefined;
    this.asrGeneration++;
    this.segmenter.flush(true);
    this.asrOffsetMs = this.timeline.positionMs;
    this.emit({
      type: "error",
      code: "provider_failed",
      message: `asr ${reason}; reconnecting`,
      fatal: false,
    });
    const delays = [0, 500, 1500];
    for (const delay of delays) {
      if (this._state !== "active") return;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        await this.openAsr();
        if (this.asr) {
          this.asrRestarts++;
          this.replayPending();
          return;
        }
      } catch {
        // try again
      }
    }
    if (this._state !== "active") return;
    this.emit({
      type: "error",
      code: "provider_failed",
      message: `asr ${reason}; could not reconnect`,
      fatal: true,
    });
    void this.stop("asr_failed");
  }

  /** Client-side VAD detected end of speech. */
  speechEnded(): void {
    if (this._state !== "active") return;
    this.asr?.finalize();
    this.segmenter.speechEnded();
  }

  /** Most recent translated-audio backlog reported by the client's player. */
  private backlogMs = 0;

  /**
   * Client tells us when a segment actually started playing (already converted to this session's clock)
   * and how much translated audio is still queued behind it.
   */
  reportPlayback(segmentId: number, playbackStartTsMs: number, backlogMs = 0): void {
    this.backlogMs = backlogMs;
    this.tracer.mark(segmentId, "playbackStart", playbackStartTsMs);
    const hops = this.tracer.get(segmentId);
    if (hops) this.emit({ type: "trace", segmentId, hops });
  }

  async stop(reason = "client"): Promise<void> {
    if (this._state === "stopped" || this._state === "stopping") return;
    this._state = "stopping";
    this.segmenter.flush(true);
    this.segmenter.dispose();
    this.dropSpeculation();
    this.asr?.close();
    this.asr = undefined;
    await Promise.allSettled([...this.inflight]);
    this._state = "stopped";
    this.emit({ type: "session.stopped", reason });
  }

  private onAsrEvent(event: AsrEvent, generation: number): void {
    if (this._state !== "active" || generation !== this.asrGeneration) return;
    if (event.type === "error" || event.type === "closed") {
      void this.reconnectAsr(event.type === "error" ? describe(event.error) : "socket closed");
      return;
    }
    const off = this.asrOffsetMs;
    if (off === 0) {
      this.segmenter.handle(event);
      return;
    }
    const shift = (words: readonly AsrWord[]): AsrWord[] =>
      words.map((w) => ({ ...w, startMs: w.startMs + off, endMs: w.endMs + off }));
    switch (event.type) {
      case "partial":
        this.segmenter.handle({ ...event, words: shift(event.words) });
        break;
      case "final":
        this.segmenter.handle({ ...event, words: shift(event.words) });
        break;
      case "utterance_end":
        this.segmenter.handle({ ...event, lastWordEndMs: event.lastWordEndMs + off });
        break;
      default:
        this.segmenter.handle(event);
    }
  }

  private scheduleSpeculation(segmentId: number, text: string): void {
    if (!this.speculative || this._state !== "active") return;
    if (text.trim().split(/\s+/).length < 2) return;
    const cur = this.speculation;
    if (cur && cur.segmentId === segmentId && sameWords(cur.text, text)) return;
    if (this.speculationTimer !== undefined) clearTimeout(this.speculationTimer);
    this.speculationTimer = setTimeout(() => {
      this.speculationTimer = undefined;
      this.startSpeculation(segmentId, text);
    }, this.speculationDebounceMs);
  }

  private startSpeculation(segmentId: number, text: string): void {
    if (this._state !== "active") return;
    this.dropSpeculation();
    const abort = new AbortController();
    const s: Speculation = {
      segmentId,
      text,
      startedAt: this.clock.now(),
      tokens: [],
      sink: undefined,
      failed: false,
      abort,
      result: Promise.resolve(""),
    };
    s.result = this.providers.mt
      .translate(
        {
          text,
          sourceLang: this.sourceLang,
          targetLang: this.targetLang,
          context: this.context.snapshot(),
        },
        (token) => {
          s.tokens.push(token);
          s.sink?.(token);
        },
        abort.signal,
      )
      .catch((err: unknown) => {
        s.failed = true;
        throw err;
      });
    s.result.catch(() => undefined);
    this.speculation = s;
  }

  /** Someone is speaking: get the TTS connection ready so the first byte is not behind a handshake. */
  private warmTts(): void {
    this.providers.tts.warm?.(
      this.cfg.voice
        ? { language: this.targetLang, voice: this.cfg.voice }
        : { language: this.targetLang },
    );
  }

  /** Hand the in-flight speculation to the closed segment if it was translating the same words. */
  private takeSpeculation(seg: Segment): Speculation | undefined {
    if (this.speculationTimer !== undefined) {
      clearTimeout(this.speculationTimer);
      this.speculationTimer = undefined;
    }
    const s = this.speculation;
    this.speculation = undefined;
    if (!s) return undefined;
    if (s.segmentId === seg.id && !s.failed && speculationMatches(s.text, seg.text)) {
      this.speculationHits++;
      return s;
    }
    this.speculationMisses++;
    s.abort.abort();
    return undefined;
  }

  private dropSpeculation(): void {
    if (this.speculationTimer !== undefined) {
      clearTimeout(this.speculationTimer);
      this.speculationTimer = undefined;
    }
    this.speculation?.abort.abort();
    this.speculation = undefined;
  }

  private onSegment(seg: Segment): void {
    const job = this.processSegment(seg).catch((err) => {
      this.emit({ type: "error", code: "provider_failed", message: describe(err), fatal: false });
    });
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
  }

  private async processSegment(seg: Segment): Promise<void> {
    const id = seg.id;
    const now = this.clock.now();
    this.tracer.mark(id, "speechStart", this.timeline.arrivalOf(seg.speechStartMs) ?? now);
    this.tracer.mark(id, "speechEnd", this.timeline.arrivalOf(seg.speechEndMs) ?? now);
    this.tracer.mark(id, "asrFinal", now);
    this.emit({
      type: "transcript",
      segmentId: id,
      text: seg.text,
      committed: seg.text,
      final: true,
    });

    const spec = this.takeSpeculation(seg);
    const slot = this.sequencer.open(id);
    const queue = new TextQueue();
    const speed = ttsSpeedFor(this.backlogMs);
    const ttsOpts = {
      language: this.targetLang,
      ...(this.cfg.voice ? { voice: this.cfg.voice } : {}),
      ...(speed !== 1 ? { speed } : {}),
    };
    const tts = this.providers.tts
      .synthesize(queue, ttsOpts, (pcm) => {
        this.tracer.mark(id, "ttsFirstByte");
        slot.push(pcm);
      })
      .then(() => this.tracer.mark(id, "ttsDone"));

    let translation = "";
    const onToken = (token: string) => {
      this.tracer.mark(id, "mtFirstToken");
      translation += token;
      queue.push(token);
      this.emit({ type: "translation", segmentId: id, text: translation, final: false });
    };
    try {
      if (spec) {
        this.tracer.mark(id, "mtStart", spec.startedAt);
        for (const t of spec.tokens) onToken(t);
        spec.sink = onToken;
        translation = await spec.result;
      } else {
        this.tracer.mark(id, "mtStart");
        translation = await this.providers.mt.translate(
          {
            text: seg.text,
            sourceLang: this.sourceLang,
            targetLang: this.targetLang,
            context: this.context.snapshot(),
          },
          onToken,
        );
      }
      this.tracer.mark(id, "mtDone");
      this.emit({ type: "translation", segmentId: id, text: translation, final: true });
      this.context.push(seg.text, translation);
      queue.close();
      await tts;
    } catch (err) {
      queue.fail(err);
      await tts.catch(() => undefined);
      throw err;
    } finally {
      slot.end();
      const hops = this.tracer.get(id);
      if (hops) this.emit({ type: "trace", segmentId: id, hops });
    }
  }

  private emit(message: ServerMessage): void {
    this.handlers.onMessage(message);
  }
}

const normalizeWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length > 0);

function sameWords(a: string, b: string): boolean {
  const x = normalizeWords(a);
  const y = normalizeWords(b);
  return x.length === y.length && x.every((w, i) => w === y[i]);
}

/** Same words, and the hypothesis already knew it was a question if the final turned out to be one. */
function speculationMatches(hypothesis: string, final: string): boolean {
  if (!sameWords(hypothesis, final)) return false;
  return !final.trimEnd().endsWith("?") || hypothesis.trimEnd().endsWith("?");
}

/**
 * Backlog control, first layer: when the listener is more than a sentence behind, ask the voice to
 * speak a little faster (still natural — 1.15× is a brisk speaker). The client's pitch-preserving
 * time-stretch is the second layer, for when even that is not enough.
 */
export function ttsSpeedFor(
  backlogMs: number,
  comfortMs = 1200,
  panicMs = 4000,
  max = 1.15,
): number {
  if (backlogMs <= comfortMs) return 1;
  const t = Math.min(1, (backlogMs - comfortMs) / (panicMs - comfortMs));
  return Math.round((1 + (max - 1) * t) * 20) / 20;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
