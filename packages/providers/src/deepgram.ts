import type { AsrEvent, AsrProvider, AsrStartOptions, AsrStream, AsrWord } from "@parley/core";
import { int16ToBytes } from "./pcm.js";

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  /** Vendor endpointing silence, ms. Lower = faster finals, more fragments. */
  endpointingMs?: number;
  utteranceEndMs?: number;
  baseUrl?: string;
}

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
}
interface DgResult {
  type: "Results" | "UtteranceEnd" | "Metadata" | "SpeechStarted";
  is_final?: boolean;
  speech_final?: boolean;
  last_word_end?: number;
  channel?: { alternatives: Array<{ transcript: string; words: DgWord[] }> };
}

/** Deepgram streaming ASR over WebSocket (linear16 input, interim results, vendor endpointing). */
export class DeepgramAsrProvider implements AsrProvider {
  readonly name = "deepgram";
  constructor(private readonly opts: DeepgramOptions) {
    if (!opts.apiKey) throw new Error("DEEPGRAM_API_KEY is required");
  }

  start(opts: AsrStartOptions, onEvent: (e: AsrEvent) => void): Promise<AsrStream> {
    const params = new URLSearchParams({
      model: this.opts.model ?? "nova-3",
      language: opts.language,
      encoding: "linear16",
      sample_rate: String(opts.sampleRate),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: String(this.opts.endpointingMs ?? 300),
      utterance_end_ms: String(this.opts.utteranceEndMs ?? 1000),
      vad_events: "true",
    });
    const url = `${this.opts.baseUrl ?? "wss://api.deepgram.com/v1/listen"}?${params}`;
    // Browsers cannot set headers on WebSocket; Deepgram accepts the key as a subprotocol there.
    const ws = new WebSocket(url, ["token", this.opts.apiKey]);
    ws.binaryType = "arraybuffer";

    return new Promise<AsrStream>((resolve, reject) => {
      let opened = false;
      const keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 5000);
      ws.onopen = () => {
        opened = true;
        resolve({
          sendAudio: (pcm) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(int16ToBytes(pcm));
          },
          finalize: () => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
          },
          close: () => {
            clearInterval(keepAlive);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
            ws.close();
          },
        });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: DgResult;
        try {
          msg = JSON.parse(ev.data) as DgResult;
        } catch {
          return;
        }
        if (msg.type === "UtteranceEnd") {
          onEvent({ type: "utterance_end", lastWordEndMs: (msg.last_word_end ?? 0) * 1000 });
          return;
        }
        if (msg.type !== "Results" || !msg.channel) return;
        const alt = msg.channel.alternatives[0];
        if (!alt) return;
        const words: AsrWord[] = alt.words.map((w) => ({
          word: w.punctuated_word ?? w.word,
          startMs: w.start * 1000,
          endMs: w.end * 1000,
        }));
        if (msg.is_final) {
          if (words.length === 0 && !msg.speech_final) return;
          onEvent({
            type: "final",
            text: alt.transcript,
            words,
            speechFinal: msg.speech_final ?? false,
          });
        } else if (words.length > 0) {
          onEvent({ type: "partial", text: alt.transcript, words });
        }
      };
      ws.onerror = () => {
        const err = new Error("deepgram websocket error");
        if (!opened) reject(err);
        else onEvent({ type: "error", error: err });
      };
      ws.onclose = (ev) => {
        clearInterval(keepAlive);
        if (!opened) reject(new Error(`deepgram closed before open: ${ev.code} ${ev.reason}`));
        else onEvent({ type: "closed" });
      };
    });
  }
}
