import type { TtsOptions, TtsProvider } from "@nyv/core";
import type { LanguageCode } from "@nyv/protocol";
import { base64ToBytes, bytesToInt16 } from "./pcm.js";

export interface ElevenLabsOptions {
  apiKey: string;
  modelId?: string;
  /** Default voice per language; any multilingual voice works for all of them. */
  voices?: Partial<Record<LanguageCode, string>>;
  /** Fallback when no per-language voice is set. */
  defaultVoice?: string;
  sampleRate?: 16000 | 22050 | 24000 | 44100;
  baseUrl?: string;
}

/** "Sarah": a premade multilingual voice, usable on free-tier keys (library voices are not). */
const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";

/**
 * ElevenLabs streaming TTS with streaming *text input* (stream-input WebSocket): audio starts coming
 * back while the translation is still being generated.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name: string;
  readonly outputSampleRate: number;
  constructor(private readonly opts: ElevenLabsOptions) {
    if (!opts.apiKey) throw new Error("ELEVENLABS_API_KEY is required");
    this.outputSampleRate = opts.sampleRate ?? 24000;
    this.name = `elevenlabs:${opts.modelId ?? "eleven_flash_v2_5"}`;
  }

  synthesize(
    text: AsyncIterable<string>,
    o: TtsOptions,
    onAudio: (pcm: Int16Array) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const voice =
      o.voice ?? this.opts.voices?.[o.language] ?? this.opts.defaultVoice ?? DEFAULT_VOICE;
    const params = new URLSearchParams({
      model_id: this.opts.modelId ?? "eleven_flash_v2_5",
      output_format: `pcm_${this.outputSampleRate}`,
      language_code: o.language,
      // Smaller first chunk → lower time-to-first-byte at the cost of slightly less natural prosody.
      inactivity_timeout: "20",
    });
    const url = `${this.opts.baseUrl ?? "wss://api.elevenlabs.io"}/v1/text-to-speech/${voice}/stream-input?${params}`;
    const ws = new WebSocket(url);

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (err: Error) => {
        if (finished) return;
        finished = true;
        ws.close();
        reject(err);
      };
      signal?.addEventListener("abort", () => fail(new Error("aborted")));

      ws.onopen = async () => {
        ws.send(
          JSON.stringify({
            text: " ",
            xi_api_key: this.opts.apiKey,
            voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.0 },
            generation_config: { chunk_length_schedule: [50, 90, 140, 200] },
          }),
        );
        try {
          for await (const chunk of text) {
            if (ws.readyState !== WebSocket.OPEN) break;
            if (chunk.length > 0) ws.send(JSON.stringify({ text: chunk }));
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ text: "" })); // end of input
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        const msg = JSON.parse(ev.data) as {
          audio?: string | null;
          isFinal?: boolean | null;
          error?: string;
          message?: string;
        };
        if (msg.error) return fail(new Error(`elevenlabs: ${msg.message ?? msg.error}`));
        if (msg.audio) onAudio(bytesToInt16(base64ToBytes(msg.audio)));
        if (msg.isFinal) {
          finished = true;
          ws.close();
          resolve();
        }
      };
      ws.onerror = () => fail(new Error("elevenlabs websocket error"));
      ws.onclose = (ev) => {
        if (!finished) {
          finished = true;
          // A clean close without isFinal still means the vendor is done sending.
          if (ev.code === 1000) resolve();
          else reject(new Error(`elevenlabs closed: ${ev.code} ${ev.reason}`));
        }
      };
    });
  }
}
