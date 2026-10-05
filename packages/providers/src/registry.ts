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
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_MODEL?: string;
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
      return new DeepgramAsrProvider({ apiKey: env.DEEPGRAM_API_KEY ?? "" });
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
      return new ElevenLabsTtsProvider(o);
    }
    default:
      throw new Error(`unknown TTS_PROVIDER ${env.TTS_PROVIDER}`);
  }
}
