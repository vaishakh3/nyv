import type { AsrProvider, MtProvider, Providers, TtsProvider } from "@fyv/core";
import { DeepgramAsrProvider } from "./deepgram.js";
import { DeepgramFluxAsrProvider } from "./deepgram-flux.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import { ElevenLabsDialogueTtsProvider } from "./elevenlabs-dialogue.js";
import { MockAsrProvider, MockMtProvider, MockTtsProvider } from "./mock.js";
import { OpenAiMtProvider } from "./openai-mt.js";
import { ResilientMtProvider } from "./resilient-mt.js";
import { RoutedAsrProvider } from "./routed-asr.js";
import { RoutedMtProvider } from "./routed-mt.js";
import { RoutedTtsProvider } from "./routed-tts.js";
import { ScriptGuardMtProvider } from "./script-guard-mt.js";

export interface ProviderEnv {
  ASR_PROVIDER?: string;
  MT_PROVIDER?: string;
  /** Second MT provider used when the first fails or stalls before its first token (e.g. "openai" behind "groq"). */
  MT_FALLBACK_PROVIDER?: string;
  TTS_PROVIDER?: string;
  DEEPGRAM_API_KEY?: string;
  /** "0" keeps Nova-3 for English too; by default English sources use Flux (turn-aware, ~250 ms interims). */
  DEEPGRAM_FLUX?: string;
  DEEPGRAM_ENDPOINTING_MS?: string;
  DEEPGRAM_EOT_THRESHOLD?: string;
  DEEPGRAM_EAGER_EOT_THRESHOLD?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  /**
   * Optional Groq model for Malayalam targets only (e.g. openai/gpt-oss-120b: better prose, but
   * 1.6–2.9 s first-token spikes on the free tier in our runs). Unset/"" keeps GROQ_MODEL.
   */
  GROQ_MODEL_ML?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_PREWARM?: string;
  ELEVENLABS_MODEL?: string;
  ELEVENLABS_VOICE_ID?: string;
  /** Comma-separated target languages served by the Text-to-Dialogue endpoint (v3/v4 models); default "ml". */
  ELEVENLABS_DIALOGUE_LANGS?: string;
  ELEVENLABS_DIALOGUE_MODEL?: string;
}

const csv = (s: string | undefined, fallback: string): Set<string> =>
  new Set(
    (s ?? fallback)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

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
    case "deepgram": {
      const nova = deepgramNova(env);
      if (env.DEEPGRAM_FLUX === "0" || env.DEEPGRAM_FLUX === "false") return nova;
      return new RoutedAsrProvider(
        [{ match: (lang) => lang.startsWith("en"), provider: deepgramFlux(env) }],
        nova,
      );
    }
    case "deepgram-nova":
      return deepgramNova(env);
    case "deepgram-flux":
      return deepgramFlux(env);
    default:
      throw new Error(`unknown ASR_PROVIDER ${env.ASR_PROVIDER}`);
  }
}

function deepgramNova(env: ProviderEnv): DeepgramAsrProvider {
  return new DeepgramAsrProvider({
    apiKey: env.DEEPGRAM_API_KEY ?? "",
    ...(env.DEEPGRAM_ENDPOINTING_MS ? { endpointingMs: Number(env.DEEPGRAM_ENDPOINTING_MS) } : {}),
  });
}

function deepgramFlux(env: ProviderEnv): DeepgramFluxAsrProvider {
  return new DeepgramFluxAsrProvider({
    apiKey: env.DEEPGRAM_API_KEY ?? "",
    ...(env.DEEPGRAM_EOT_THRESHOLD ? { eotThreshold: Number(env.DEEPGRAM_EOT_THRESHOLD) } : {}),
    ...(env.DEEPGRAM_EAGER_EOT_THRESHOLD
      ? { eagerEotThreshold: Number(env.DEEPGRAM_EAGER_EOT_THRESHOLD) }
      : {}),
  });
}

export function mtFromEnv(env: ProviderEnv): MtProvider {
  const mt = routedMtFromEnv(env);
  return mt.name.startsWith("mock") ? mt : new ScriptGuardMtProvider(mt);
}

function routedMtFromEnv(env: ProviderEnv): MtProvider {
  const name = env.MT_PROVIDER ?? "mock";
  const primary = resilient(env, mtByName(env, name));
  if (name !== "groq") return primary;
  const mlModel = env.GROQ_MODEL_ML;
  if (!mlModel || mlModel === (env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL)) return primary;
  return new RoutedMtProvider(
    [{ match: (lang) => lang === "ml", provider: resilient(env, groq(env, mlModel)) }],
    primary,
  );
}

function resilient(env: ProviderEnv, primary: MtProvider): MtProvider {
  if (!env.MT_FALLBACK_PROVIDER || env.MT_FALLBACK_PROVIDER === env.MT_PROVIDER) {
    return primary.name.startsWith("mock") ? primary : new ResilientMtProvider(primary, undefined);
  }
  return new ResilientMtProvider(primary, mtByName(env, env.MT_FALLBACK_PROVIDER));
}

const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";

function groq(env: ProviderEnv, model: string): OpenAiMtProvider {
  return new OpenAiMtProvider({
    apiKey: env.GROQ_API_KEY ?? "",
    baseUrl: "https://api.groq.com/openai/v1",
    model,
    label: "groq",
    // gpt-oss models think before answering unless told not to; translation needs no reasoning.
    ...(model.includes("gpt-oss") ? { extraBody: { reasoning_effort: "low" } } : {}),
  });
}

function mtByName(env: ProviderEnv, name: string): MtProvider {
  switch (name) {
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
    case "groq":
      return groq(env, env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
    default:
      throw new Error(`unknown MT_PROVIDER ${name}`);
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
      const flash = new ElevenLabsTtsProvider(o);
      // Flash v2.5 rejects languages outside its 32 (Malayalam included); those go to the v4 dialogue endpoint.
      const dialogueLangs = csv(env.ELEVENLABS_DIALOGUE_LANGS, "ml");
      if (dialogueLangs.size === 0) return flash;
      const d: ConstructorParameters<typeof ElevenLabsDialogueTtsProvider>[0] = {
        apiKey: o.apiKey,
        sampleRate: flash.outputSampleRate as 24000,
      };
      if (env.ELEVENLABS_DIALOGUE_MODEL) d.modelId = env.ELEVENLABS_DIALOGUE_MODEL;
      if (o.defaultVoice) d.defaultVoice = o.defaultVoice;
      if (o.prewarm === false) d.prewarm = false;
      return new RoutedTtsProvider(
        [
          {
            match: (lang) => dialogueLangs.has(lang),
            provider: new ElevenLabsDialogueTtsProvider(d),
          },
        ],
        flash,
      );
    }
    default:
      throw new Error(`unknown TTS_PROVIDER ${env.TTS_PROVIDER}`);
  }
}
