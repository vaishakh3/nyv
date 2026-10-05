import type { SessionConfig } from "@nyv/protocol";

export type EngineState = "idle" | "connecting" | "active" | "error";

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

export interface Settings {
  relayUrl: string;
  /** Bearer token for relays started with RELAY_TOKENS; sent as `?token=`. */
  relayToken: string;
  sourceLang: SessionConfig["sourceLang"];
  targetLang: SessionConfig["targetLang"];
  captions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: "ws://localhost:8787/v1/session",
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
