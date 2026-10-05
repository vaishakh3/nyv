import type { AsrProvider, MtProvider, Providers, TtsProvider } from "@nyv/core";
import { DeepgramAsrProvider } from "./deepgram.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { MockAsrProvider, MockMtProvider, MockTtsProvider } from "./mock.js";
import { OpenAiMtProvider } from "./openai-mt.js";

export interface ProviderEnv {
  ASR_PROVIDER?: string;
  MT_PROVIDER?: string;
  TTS_PROVIDER?: string;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_ENDPOINTING_MS?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_PREWARM?: string;
  ELEVENLABS_MODEL?: string;
  ELEVENLABS_VOICE_ID?: string;
}

/** Builds the provider set from environment-style config. Unknown names fail loudly; "mock" always works. */
export function providersFromEnv(env: ProviderEnv): Providers {
  return {
    asr: asrFromEnv(env),
    mt: mtFromEnv(env),
    tts: ttsFromEnv(env),
  };
}

export function asrFromEnv(env: ProviderEnv): AsrProvider {
  switch (env.ASR_PROVIDER ?? "mock") {
    case "mock":
      return new MockAsrProvider();
    case "deepgram":
      return new DeepgramAsrProvider({
        apiKey: env.DEEPGRAM_API_KEY ?? "",
        ...(env.DEEPGRAM_ENDPOINTING_MS
          ? { endpointingMs: Number(env.DEEPGRAM_ENDPOINTING_MS) }
          : {}),
      });
    default:
      throw new Error(`unknown ASR_PROVIDER ${env.ASR_PROVIDER}`);
  }
}

export function mtFromEnv(env: ProviderEnv): MtProvider {
  switch (env.MT_PROVIDER ?? "mock") {
    case "mock":
      return new MockMtProvider();
    case "openai": {
      const o: ConstructorParameters<typeof OpenAiMtProvider>[0] = {
        apiKey: env.OPENAI_API_KEY ?? "",
      };
      if (env.OPENAI_MODEL) o.model = env.OPENAI_MODEL;
      if (env.OPENAI_BASE_URL) o.baseUrl = env.OPENAI_BASE_URL;
      return new OpenAiMtProvider(o);
    }
    case "groq": {
      const model = env.GROQ_MODEL ?? "openai/gpt-oss-20b";
      return new OpenAiMtProvider({
        apiKey: env.GROQ_API_KEY ?? "",
        baseUrl: "https://api.groq.com/openai/v1",
        model,
        label: "groq",
        // gpt-oss models think before answering unless told not to; translation needs no reasoning.
        ...(model.includes("gpt-oss") ? { extraBody: { reasoning_effort: "low" } } : {}),
      });
    }
    default:
      throw new Error(`unknown MT_PROVIDER ${env.MT_PROVIDER}`);
  }
}

export function ttsFromEnv(env: ProviderEnv): TtsProvider {
  switch (env.TTS_PROVIDER ?? "mock") {
    case "mock":
      return new MockTtsProvider();
    case "elevenlabs": {
      const o: ConstructorParameters<typeof ElevenLabsTtsProvider>[0] = {
        apiKey: env.ELEVENLABS_API_KEY ?? "",
      };
      if (env.ELEVENLABS_MODEL) o.modelId = env.ELEVENLABS_MODEL;
      if (env.ELEVENLABS_VOICE_ID) o.defaultVoice = env.ELEVENLABS_VOICE_ID;
      if (env.ELEVENLABS_PREWARM === "0" || env.ELEVENLABS_PREWARM === "false") o.prewarm = false;
      return new ElevenLabsTtsProvider(o);
    }
    default:
      throw new Error(`unknown TTS_PROVIDER ${env.TTS_PROVIDER}`);
  }
}
