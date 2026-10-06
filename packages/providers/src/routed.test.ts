import type { MtProvider, MtRequest, TtsOptions, TtsProvider } from "@fyv/core";
import { describe, expect, it } from "vitest";
import { mtFromEnv, ttsFromEnv } from "./registry.js";
import { RoutedMtProvider } from "./routed-mt.js";
import { RoutedTtsProvider } from "./routed-tts.js";

function tts(name: string, rate = 24000): TtsProvider & { warmed: string[]; spoke: string[] } {
  const p = {
    name,
    outputSampleRate: rate,
    warmed: [] as string[],
    spoke: [] as string[],
    warm: (o: TtsOptions) => {
      p.warmed.push(o.language);
    },
    synthesize: async (_t: AsyncIterable<string>, o: TtsOptions) => {
      p.spoke.push(o.language);
    },
  };
  return p;
}

const req = (targetLang: MtRequest["targetLang"]): MtRequest => ({
  text: "Hello.",
  sourceLang: "en",
  targetLang,
  context: { history: [], glossary: [] },
});

describe("RoutedTtsProvider", () => {
  it("sends warm and synthesize for routed languages to their provider, the rest to the fallback", async () => {
    const ml = tts("dialogue");
    const hi = tts("flash");
    const r = new RoutedTtsProvider([{ match: (l) => l === "ml", provider: ml }], hi);
    r.warm({ language: "ml" });
    r.warm({ language: "hi" });
    await r.synthesize((async function* () {})(), { language: "ml" }, () => {});
    await r.synthesize((async function* () {})(), { language: "es" }, () => {});
    expect(ml.warmed).toEqual(["ml"]);
    expect(ml.spoke).toEqual(["ml"]);
    expect(hi.warmed).toEqual(["hi"]);
    expect(hi.spoke).toEqual(["es"]);
    expect(r.name).toBe("dialogue|flash");
    expect(r.outputSampleRate).toBe(24000);
  });

  it("refuses providers with different sample rates (the session has one output rate)", () => {
    expect(
      () => new RoutedTtsProvider([{ match: () => true, provider: tts("a", 16000) }], tts("b")),
    ).toThrow(/16000 Hz/);
  });
});

describe("RoutedMtProvider", () => {
  it("routes by target language", async () => {
    const calls: string[] = [];
    const mt = (name: string): MtProvider => ({
      name,
      translate: async (r) => {
        calls.push(`${name}:${r.targetLang}`);
        return "";
      },
    });
    const r = new RoutedMtProvider(
      [{ match: (l) => l === "ml", provider: mt("big") }],
      mt("small"),
    );
    await r.translate(req("ml"), () => {});
    await r.translate(req("hi"), () => {});
    expect(calls).toEqual(["big:ml", "small:hi"]);
  });
});

describe("registry routing", () => {
  it("elevenlabs: Malayalam goes to the v4 dialogue endpoint, everything else stays on Flash", () => {
    const p = ttsFromEnv({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" });
    expect(p.name).toBe("elevenlabs:eleven_v4_turbo|elevenlabs:eleven_flash_v2_5");
    expect(
      ttsFromEnv({
        TTS_PROVIDER: "elevenlabs",
        ELEVENLABS_API_KEY: "k",
        ELEVENLABS_DIALOGUE_LANGS: "",
      }).name,
    ).toBe("elevenlabs:eleven_flash_v2_5");
  });

  it("groq: GROQ_MODEL_ML routes only Malayalam, with the same fallback as the primary", () => {
    const p = mtFromEnv({
      MT_PROVIDER: "groq",
      GROQ_API_KEY: "k",
      GROQ_MODEL_ML: "openai/gpt-oss-120b",
      MT_FALLBACK_PROVIDER: "openai",
      OPENAI_API_KEY: "k",
    });
    expect(p.name).toBe(
      "groq:openai/gpt-oss-120b→openai:gpt-4o-mini|groq:openai/gpt-oss-20b→openai:gpt-4o-mini",
    );
    expect(mtFromEnv({ MT_PROVIDER: "groq", GROQ_API_KEY: "k" }).name).toBe(
      "groq:openai/gpt-oss-20b",
    );
    expect(mtFromEnv({ MT_PROVIDER: "groq", GROQ_API_KEY: "k", GROQ_MODEL_ML: "" }).name).toBe(
      "groq:openai/gpt-oss-20b",
    );
  });
});
