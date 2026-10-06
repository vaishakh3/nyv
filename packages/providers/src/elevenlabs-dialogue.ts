import type { TtsOptions, TtsProvider } from "@fyv/core";
import type { LanguageCode } from "@fyv/protocol";
import { base64ToBytes, bytesToInt16 } from "./pcm.js";

export interface ElevenLabsDialogueOptions {
  apiKey: string;
  /** A v3/v4 dialogue model; Flash/Turbo v2.5 models are rejected by this endpoint. */
  modelId?: string;
  voices?: Partial<Record<LanguageCode, string>>;
  defaultVoice?: string;
  sampleRate?: 16000 | 22050 | 24000 | 44100;
  baseUrl?: string;
  prewarm?: boolean;
}

interface WarmSocket {
  /** `${voice}|${language}|${speed}` */
  key: string;
  ws: WebSocket;
  opened: Promise<void>;
}

const sameVoice = (a: string, b: string) =>
  a.split("|").slice(0, 2).join("|") === b.split("|").slice(0, 2).join("|");

const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_MODEL = "eleven_v4_turbo";

/**
 * ElevenLabs Text-to-Dialogue WebSocket, which is where the v3/v4 realtime models live. Used for
 * languages Flash v2.5 does not speak (Malayalam first); measured ~160 ms to first byte for v4 Turbo.
 * One socket per segment (one dialogue "session"), pre-opened like the stream-input adapter.
 */
export class ElevenLabsDialogueTtsProvider implements TtsProvider {
  readonly name: string;
  readonly outputSampleRate: number;
  constructor(private readonly opts: ElevenLabsDialogueOptions) {
    if (!opts.apiKey) throw new Error("ELEVENLABS_API_KEY is required");
    this.outputSampleRate = opts.sampleRate ?? 24000;
    this.name = `elevenlabs:${opts.modelId ?? DEFAULT_MODEL}`;
  }

  private spare: WarmSocket | undefined;

  warm(o: TtsOptions): void {
    if (this.opts.prewarm === false) return;
    const key = this.keyFor(o);
    if (this.spare && this.spare.key === key && this.spare.ws.readyState <= WebSocket.OPEN) return;
    this.spare?.ws.close();
    const w = this.connect(key);
    this.spare = w;
    w.ws.addEventListener("close", () => {
      if (this.spare === w) this.spare = undefined;
    });
    w.opened.catch(() => {
      if (this.spare === w) this.spare = undefined;
    });
  }

  synthesize(
    text: AsyncIterable<string>,
    o: TtsOptions,
    onAudio: (pcm: Int16Array) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = this.keyFor(o);
    let w: WarmSocket;
    if (
      this.spare &&
      sameVoice(this.spare.key, key) &&
      this.spare.ws.readyState <= WebSocket.OPEN
    ) {
      w = this.spare;
      this.spare = undefined;
    } else {
      w = this.connect(key);
    }
    this.warm(o);
    const { ws } = w;
    const voice = key.split("|")[0] as string;

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (err: Error) => {
        if (finished) return;
        finished = true;
        ws.close();
        reject(err);
      };
      signal?.addEventListener("abort", () => fail(new Error("aborted")));

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        const msg = JSON.parse(ev.data) as {
          audio?: string | null;
          is_final?: boolean | null;
          error?: string;
          message?: string;
        };
        if (msg.error) return fail(new Error(`elevenlabs dialogue: ${msg.message ?? msg.error}`));
        if (msg.audio) onAudio(bytesToInt16(base64ToBytes(msg.audio)));
        if (msg.is_final) {
          finished = true;
          ws.close();
          resolve();
        }
      };
      ws.onerror = () => fail(new Error("elevenlabs dialogue websocket error"));
      ws.onclose = (ev) => {
        if (!finished) {
          finished = true;
          if (ev.code === 1000) resolve();
          else reject(new Error(`elevenlabs dialogue closed: ${ev.code} ${ev.reason}`));
        }
      };

      w.opened.then(
        async () => {
          try {
            let sent = 0;
            for await (const chunk of text) {
              if (ws.readyState !== WebSocket.OPEN) break;
              if (chunk.length === 0) continue;
              ws.send(JSON.stringify({ inputs: [{ text: chunk, voice_id: voice }] }));
              sent += chunk.length;
            }
            if (ws.readyState !== WebSocket.OPEN) return;
            if (sent === 0) {
              finished = true;
              ws.close();
              resolve();
              return;
            }
            // Flush whatever is buffered (the server holds ~40 chars before speaking), then end the session.
            ws.send(JSON.stringify({ close_socket: true }));
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        },
        (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  private keyFor(o: TtsOptions): string {
    const voice =
      o.voice ?? this.opts.voices?.[o.language] ?? this.opts.defaultVoice ?? DEFAULT_VOICE;
    const speed = Math.min(1.2, Math.max(0.7, o.speed ?? 1)).toFixed(2);
    return `${voice}|${o.language}|${speed}`;
  }

  private connect(key: string): WarmSocket {
    const [voice, language, speed] = key.split("|") as [string, string, string];
    const params = new URLSearchParams({
      model_id: this.opts.modelId ?? DEFAULT_MODEL,
      output_format: `pcm_${this.outputSampleRate}`,
      language_code: language,
    });
    const url = `${this.opts.baseUrl ?? "wss://api.elevenlabs.io"}/v1/text-to-dialogue/stream-input?${params}`;
    const ws = new WebSocket(url);
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            voices: [voice],
            xi_api_key: this.opts.apiKey,
            voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: Number(speed) },
          }),
        );
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("elevenlabs dialogue websocket error")));
      ws.addEventListener("close", (ev) =>
        reject(new Error(`elevenlabs dialogue closed before open: ${ev.code} ${ev.reason}`)),
      );
    });
    opened.catch(() => undefined);
    return { key, ws, opened };
  }
}
