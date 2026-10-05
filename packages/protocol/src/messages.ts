import { z } from "zod";
import { LANGUAGE_CODES } from "./languages.js";

/** JSON control messages. Audio goes in binary frames (see frames.ts). */

export const languageCode = z.enum(LANGUAGE_CODES as [string, ...string[]]);

export const sessionConfig = z.object({
  sourceLang: languageCode,
  targetLang: languageCode,
  /** inbound: translate what I hear. outbound: translate what I say. */
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  /** Provider voice id; relay picks a default per language when omitted. */
  voice: z.string().min(1).optional(),
  /** Capture sample rate the client sends. 16 kHz is what every ASR vendor wants. */
  inputSampleRate: z.literal(16000).default(16000),
  glossary: z
    .array(z.object({ term: z.string(), translation: z.string() }))
    .max(200)
    .default([]),
});
export type SessionConfig = z.infer<typeof sessionConfig>;

// ---- client → relay ----

export const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.start"), config: sessionConfig }),
  z.object({ type: z.literal("session.stop") }),
  /** Client-side VAD saw end of speech; lets the relay flush ASR early. */
  z.object({ type: z.literal("speech.end"), tsMs: z.number().nonnegative() }),
  /** Client reports when a segment started playing. playbackStartTsMs is already converted to the relay clock using the ping/pong offset. */
  z.object({
    type: z.literal("trace.playback"),
    segmentId: z.number().int().positive(),
    playbackStartTsMs: z.number().nonnegative(),
    backlogMs: z.number().nonnegative(),
  }),
  /** tsMs is the client's performance.now(): fractional. */
  z.object({ type: z.literal("ping"), tsMs: z.number().nonnegative() }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

// ---- relay → client ----

export const hopTimings = z.object({
  /** All relative to the relay's session clock, ms. Absent while a hop has not happened yet. */
  speechStart: z.number().optional(),
  speechEnd: z.number().optional(),
  asrFinal: z.number().optional(),
  /** When the MT request was sent; earlier than asrFinal when translated speculatively from partials. */
  mtStart: z.number().optional(),
  mtFirstToken: z.number().optional(),
  mtDone: z.number().optional(),
  ttsFirstByte: z.number().optional(),
  ttsDone: z.number().optional(),
  playbackStart: z.number().optional(),
});
export type HopTimings = z.infer<typeof hopTimings>;

export const serverMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.ready"),
    sessionId: z.string(),
    outputSampleRate: z.number().int().positive(),
    providers: z.object({ asr: z.string(), mt: z.string(), tts: z.string() }),
  }),
  z.object({ type: z.literal("session.stopped"), reason: z.string() }),
  z.object({
    type: z.literal("transcript"),
    segmentId: z.number().int().positive(),
    text: z.string(),
    /** committed = stable under LocalAgreement and will not change; the rest may still be revised. */
    committed: z.string(),
    final: z.boolean(),
  }),
  z.object({
    type: z.literal("translation"),
    segmentId: z.number().int().positive(),
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({ type: z.literal("segment.audio.start"), segmentId: z.number().int().positive() }),
  z.object({
    type: z.literal("segment.audio.end"),
    segmentId: z.number().int().positive(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({ type: z.literal("trace"), segmentId: z.number().int().positive(), hops: hopTimings }),
  z.object({
    type: z.literal("error"),
    code: z.enum([
      "bad_message",
      "bad_frame",
      "already_started",
      "capacity",
      "too_many_sessions",
      "session_expired",
      "idle",
      "provider_failed",
      "unsupported_language",
      "internal",
    ]),
    message: z.string(),
    fatal: z.boolean(),
  }),
  z.object({
    type: z.literal("pong"),
    tsMs: z.number().nonnegative(),
    serverTsMs: z.number(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessage>;

export function parseClientMessage(raw: string): ClientMessage {
  return clientMessage.parse(JSON.parse(raw));
}
export function parseServerMessage(raw: string): ServerMessage {
  return serverMessage.parse(JSON.parse(raw));
}
