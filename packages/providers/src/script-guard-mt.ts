import type { MtProvider, MtRequest } from "@fyv/core";
import type { LanguageCode } from "@fyv/protocol";

/**
 * Scripts a translation into each target language may contain, besides Latin letters, digits,
 * punctuation and symbols (names, acronyms, numbers). Languages not listed are not guarded.
 */
const TARGET_SCRIPTS: Partial<Record<LanguageCode, string>> = {
  hi: "\\p{Script=Devanagari}",
  ml: "\\p{Script=Malayalam}",
  ja: "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}",
};

const COMMON = "\\p{Script=Latin}\\p{Script=Common}\\p{Script=Inherited}";

/**
 * LLMs occasionally emit a word in an unrelated script mid-sentence in lower-resource languages
 * (every model we tried wrote "almost" as Urdu/Hebrew/Portuguese/Korean in Malayalam at least once;
 * gpt-oss-20b once degenerated into hundreds of Korean tokens). A wrong-script word is unspeakable
 * by the TTS voice, so this drops such characters from the token stream before they reach it.
 */
export class ScriptGuardMtProvider implements MtProvider {
  readonly name: string;
  /** Characters removed so far (for logs/metrics). */
  dropped = 0;
  constructor(private readonly inner: MtProvider) {
    this.name = inner.name;
  }

  warm(): void {
    this.inner.warm?.();
  }

  async translate(
    req: MtRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const strip = stripperFor(req.targetLang);
    if (!strip) return this.inner.translate(req, onToken, signal);
    let full = "";
    // Whitespace that surrounded a dropped word is held back and re-inserted only before the next word.
    let pending = "";
    await this.inner.translate(
      req,
      (token) => {
        let kept = strip(token);
        this.dropped += token.length - kept.length;
        if (kept.length < token.length) {
          if (kept.trim().length === 0) {
            if (kept.length > 0) pending = " ";
            return;
          }
          if (/\s$/u.test(kept)) {
            kept = kept.trimEnd();
            pending = " ";
          }
        }
        let out = kept;
        if (pending) {
          if (/^[\p{L}\p{N}]/u.test(out)) out = pending + out;
          pending = "";
        }
        full += out;
        onToken(out);
      },
      signal,
    );
    return full.trim();
  }
}

const cache = new Map<string, (s: string) => string>();

export function stripperFor(lang: string): ((s: string) => string) | undefined {
  const script = TARGET_SCRIPTS[lang as LanguageCode];
  if (!script) return undefined;
  let fn = cache.get(lang);
  if (!fn) {
    // A dropped letter takes its combining marks (e.g. Arabic tanween, Script=Inherited) with it.
    const re = new RegExp(`(?:[^${script}${COMMON}]\\p{M}*)+`, "gu");
    fn = (s) => s.replace(re, "");
    cache.set(lang, fn);
  }
  return fn;
}
