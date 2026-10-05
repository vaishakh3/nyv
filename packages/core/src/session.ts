import type { LanguageCode, ServerMessage, SessionConfig } from "@nyv/protocol";
import { AudioSequencer } from "./audio-sequencer.js";
import { AudioTimeline } from "./audio-timeline.js";
import { type Clock, SessionClock } from "./clock.js";
import { ContextWindow } from "./context-window.js";
import { type Segment, Segmenter, type SegmenterOptions } from "./segmenter.js";
import { TextQueue } from "./text-queue.js";
import { Tracer } from "./tracer.js";
import type { AsrEvent, AsrStream, Providers } from "./types.js";

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
  /** Audio that arrived while the ASR socket was still opening; replayed once active. */
  private pendingAudio: Int16Array[] = [];

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
        onProgress: ({ id, committed, text }) =>
          this.emit({ type: "transcript", segmentId: id, text, committed, final: false }),
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
    try {
      this.asr = await this.providers.asr.start(
        { language: this.sourceLang, sampleRate: this.cfg.inputSampleRate },
        (e) => this.onAsrEvent(e),
      );
    } catch (err) {
      this._state = "stopped";
      this.emit({ type: "error", code: "provider_failed", message: describe(err), fatal: true });
      throw err;
    }
    this._state = "active";
    for (const pcm of this.pendingAudio) this.pushAudio(pcm);
    this.pendingAudio = [];
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
    if (this._state === "starting") {
      this.pendingAudio.push(pcm);
      return;
    }
    if (this._state !== "active" || !this.asr) return;
    this.timeline.record(pcm.length, this.clock.now());
    this.asr.sendAudio(pcm);
  }

  /** Client-side VAD detected end of speech. */
  speechEnded(): void {
    if (this._state !== "active") return;
    this.asr?.finalize();
    this.segmenter.speechEnded();
  }

  /** Client tells us when a segment actually started playing (already converted to this session's clock). */
  reportPlayback(segmentId: number, playbackStartTsMs: number): void {
    this.tracer.mark(segmentId, "playbackStart", playbackStartTsMs);
    const hops = this.tracer.get(segmentId);
    if (hops) this.emit({ type: "trace", segmentId, hops });
  }

  async stop(reason = "client"): Promise<void> {
    if (this._state === "stopped" || this._state === "stopping") return;
    this._state = "stopping";
    this.segmenter.flush();
    this.segmenter.dispose();
    this.asr?.close();
    this.asr = undefined;
    await Promise.allSettled([...this.inflight]);
    this._state = "stopped";
    this.emit({ type: "session.stopped", reason });
  }

  private onAsrEvent(event: AsrEvent): void {
    if (this._state !== "active") return;
    if (event.type === "error") {
      this.emit({
        type: "error",
        code: "provider_failed",
        message: describe(event.error),
        fatal: true,
      });
      void this.stop("asr_failed");
      return;
    }
    this.segmenter.handle(event);
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

    const slot = this.sequencer.open(id);
    const queue = new TextQueue();
    const ttsOpts = this.cfg.voice
      ? { language: this.targetLang, voice: this.cfg.voice }
      : { language: this.targetLang };
    const tts = this.providers.tts
      .synthesize(queue, ttsOpts, (pcm) => {
        this.tracer.mark(id, "ttsFirstByte");
        slot.push(pcm);
      })
      .then(() => this.tracer.mark(id, "ttsDone"));

    let translation = "";
    try {
      translation = await this.providers.mt.translate(
        {
          text: seg.text,
          sourceLang: this.sourceLang,
          targetLang: this.targetLang,
          context: this.context.snapshot(),
        },
        (token) => {
          this.tracer.mark(id, "mtFirstToken");
          translation += token;
          queue.push(token);
          this.emit({ type: "translation", segmentId: id, text: translation, final: false });
        },
      );
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
