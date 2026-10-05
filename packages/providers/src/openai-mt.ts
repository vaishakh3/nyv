import type { MtProvider, MtRequest } from "@parley/core";
import { LANGUAGES, type LanguageCode } from "@parley/protocol";

export interface OpenAiMtOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * LLM translation over the OpenAI chat completions streaming API. Any OpenAI-compatible endpoint
 * (Groq, Together, local vLLM) works via baseUrl, which is how we bake off models.
 */
export class OpenAiMtProvider implements MtProvider {
  readonly name: string;
  constructor(private readonly opts: OpenAiMtOptions) {
    if (!opts.apiKey) throw new Error("OPENAI_API_KEY is required");
    this.name = `openai:${opts.model ?? "gpt-4o-mini"}`;
  }

  async translate(
    req: MtRequest,
    onToken: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(
      `${this.opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model ?? "gpt-4o-mini",
          stream: true,
          temperature: 0.2,
          messages: buildMessages(req),
        }),
        ...(signal ? { signal } : {}),
      },
    );
    if (!res.ok || !res.body) throw new Error(`openai ${res.status}: ${await res.text()}`);

    let full = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const token = extractDelta(data);
        if (token) {
          full += token;
          onToken(token);
        }
      }
    }
    return full.trim();
  }
}

function extractDelta(json: string): string | undefined {
  try {
    const parsed = JSON.parse(json) as { choices?: Array<{ delta?: { content?: string } }> };
    return parsed.choices?.[0]?.delta?.content ?? undefined;
  } catch {
    return undefined;
  }
}

export function buildMessages(
  req: MtRequest,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const src = LANGUAGES[req.sourceLang as LanguageCode]?.name ?? req.sourceLang;
  const tgt = LANGUAGES[req.targetLang as LanguageCode]?.name ?? req.targetLang;
  const glossary = req.context.glossary.length
    ? `\nGlossary (always use these renderings): ${req.context.glossary.map((g) => `${g.term} → ${g.translation}`).join("; ")}`
    : "";
  const system =
    `You are a simultaneous interpreter in a live video call, translating ${src} speech into spoken ${tgt}.\n` +
    "Rules: output only the translation, nothing else. Keep it natural and conversational, as it will be spoken aloud by a text-to-speech voice. " +
    "Preserve meaning, tone and register; use the polite register unless the speaker is clearly casual. " +
    "Keep names, numbers, product names and acronyms as-is. If the input is a fragment, translate the fragment; never complete or answer it. " +
    "The input may mix languages; translate all of it into the target language." +
    glossary;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
  ];
  for (const pair of req.context.history) {
    messages.push(
      { role: "user", content: pair.source },
      { role: "assistant", content: pair.target },
    );
  }
  messages.push({ role: "user", content: req.text });
  return messages;
}
