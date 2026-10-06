import type { SessionConfig } from "@fyv/protocol";

export type EngineState = "idle" | "connecting" | "active" | "reconnecting" | "error";

export interface Status {
  state: EngineState;
  tabId?: number;
  error?: string;
  /** Last measured speechEnd → playback latency and running p50 (ms). */
  latency?: { last: number; p50: number; n: number };
  backlogMs: number;
  rate: number;
  ducking: boolean;
  level: number;
  providers?: { asr: string; mt: string; tts: string };
}

export const IDLE_STATUS: Status = {
  state: "idle",
  backlogMs: 0,
  rate: 1,
  ducking: false,
  level: -90,
};

export interface Caption {
  segmentId: number;
  source: string;
  target: string;
  final: boolean;
}

/** The hosted fyv relay (Fly.io, `apps/relay`). Self-hosters point `relayUrl` elsewhere under Advanced. */
export const HOSTED_RELAY_URL = "wss://relay.fyv.si/v1/session";

export interface Settings {
  relayUrl: string;
  /** Access code for the hosted relay (a RELAY_TOKENS entry); sent as `?token=`. */
  relayToken: string;
  sourceLang: SessionConfig["sourceLang"];
  targetLang: SessionConfig["targetLang"];
  captions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: HOSTED_RELAY_URL,
  relayToken: "",
  sourceLang: "en",
  targetLang: "hi",
  captions: true,
};

/** popup → background */
export type PopupCommand =
  | { type: "start"; tabId: number; settings: Settings }
  | { type: "stop" }
  | { type: "getStatus" };

/** background → offscreen */
export type OffscreenCommand =
  | { target: "offscreen"; type: "start"; streamId: string; settings: Settings }
  | { target: "offscreen"; type: "stop" };

/** offscreen → background → popup/content */
export type Broadcast =
  | { target: "background"; type: "status"; status: Status }
  | { target: "background"; type: "caption"; caption: Caption };

export type ContentMessage =
  | { type: "caption"; caption: Caption }
  | { type: "status"; status: Status };
