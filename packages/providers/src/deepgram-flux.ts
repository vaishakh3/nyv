import type { AsrEvent, AsrProvider, AsrStartOptions, AsrStream, AsrWord } from "@nyv/core";
import { int16ToBytes } from "./pcm.js";

export interface DeepgramFluxOptions {
  apiKey: string;
  model?: string;
  /** End-of-turn confidence that closes a turn (vendor default 0.7). */
  eotThreshold?: number;
  /** Fire EagerEndOfTurn at this confidence (0.3–0.9) so we can start translating early. */
  eagerEotThreshold?: number;
  /** Close a turn after this much silence regardless of confidence. */
  eotTimeoutMs?: number;
  baseUrl?: string;
}

interface FluxWord {
  word: string;
  confidence: number;
  start: number;
  end: number;
}
interface FluxMessage {
  type: "Connected" | "TurnInfo" | "Error";
  event?: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  turn_index?: number;
  transcript?: string;
  words?: FluxWord[];
  end_of_turn_confidence?: number;
  description?: string;
  code?: string;
}

/**
 * Deepgram Flux: turn-aware streaming ASR (English). Unlike Nova's ~1 s interims, Flux emits an
 * `Update` with word timings every ~250 ms, so the segmenter can commit words (and cut segments on
 * punctuation) while the speaker is still talking instead of waiting for a vendor `is_final`.
 * Each turn's Updates carry the whole turn so far; the segmenter drops words it has already shipped.
 */
export class DeepgramFluxAsrProvider implements AsrProvider {
  readonly name = "deepgram-flux";
  constructor(private readonly opts: DeepgramFluxOptions) {
    if (!opts.apiKey) throw new Error("DEEPGRAM_API_KEY is required");
  }

  start(opts: AsrStartOptions, onEvent: (e: AsrEvent) => void): Promise<AsrStream> {
    if (!opts.language.startsWith("en"))
      return Promise.reject(new Error(`deepgram flux is English-only (got ${opts.language})`));
    const params = new URLSearchParams({
      model: this.opts.model ?? "flux-general-en",
      encoding: "linear16",
      sample_rate: String(opts.sampleRate),
      eot_threshold: String(this.opts.eotThreshold ?? 0.7),
    });
    if (this.opts.eagerEotThreshold !== undefined)
      params.set("eager_eot_threshold", String(this.opts.eagerEotThreshold));
    if (this.opts.eotTimeoutMs !== undefined)
      params.set("eot_timeout_ms", String(this.opts.eotTimeoutMs));
    const url = `${this.opts.baseUrl ?? "wss://api.deepgram.com/v2/listen"}?${params}`;
    const ws = new WebSocket(url, ["token", this.opts.apiKey]);
    ws.binaryType = "arraybuffer";

    return new Promise<AsrStream>((resolve, reject) => {
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve({
          sendAudio: (pcm) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(int16ToBytes(pcm));
          },
          // Flux decides turn ends itself; client VAD only informs our segmenter.
          finalize: () => {},
          close: () => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
            ws.close();
          },
        });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: FluxMessage;
        try {
          msg = JSON.parse(ev.data) as FluxMessage;
        } catch {
          return;
        }
        if (msg.type === "Error") {
          onEvent({
            type: "error",
            error: new Error(`deepgram flux: ${msg.description ?? msg.code}`),
          });
          return;
        }
        if (msg.type !== "TurnInfo" || !msg.words) return;
        const words: AsrWord[] = msg.words.map((w) => ({
          word: w.word,
          startMs: w.start * 1000,
          endMs: w.end * 1000,
        }));
        const text = msg.transcript ?? words.map((w) => w.word).join(" ");
        switch (msg.event) {
          case "EndOfTurn":
            onEvent({ type: "final", text, words, speechFinal: true });
            onEvent({
              type: "utterance_end",
              lastWordEndMs: words.length > 0 ? (words[words.length - 1] as AsrWord).endMs : 0,
            });
            break;
          case "StartOfTurn":
          case "Update":
          case "EagerEndOfTurn":
          case "TurnResumed":
            if (words.length > 0) onEvent({ type: "partial", text, words });
            break;
          default:
            break;
        }
      };
      ws.onerror = () => {
        const err = new Error("deepgram flux websocket error");
        if (!opened) reject(err);
        else onEvent({ type: "error", error: err });
      };
      ws.onclose = (ev) => {
        if (!opened) reject(new Error(`deepgram flux closed before open: ${ev.code} ${ev.reason}`));
        else onEvent({ type: "closed" });
      };
    });
  }
}
