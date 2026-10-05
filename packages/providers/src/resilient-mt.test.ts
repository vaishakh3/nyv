import type { MtProvider, MtRequest } from "@nyv/core";
import { describe, expect, it } from "vitest";
import { ResilientMtProvider } from "./resilient-mt.js";

const req: MtRequest = {
  text: "Hello there.",
  sourceLang: "en",
  targetLang: "hi",
  context: { history: [], glossary: [] },
};

function provider(
  name: string,
  behave: (onToken: (t: string) => void, call: number) => Promise<string>,
): MtProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    translate: (_r: MtRequest, onToken: (t: string) => void) => behave(onToken, ++p.calls),
  };
  return p;
}

describe("ResilientMtProvider", () => {
  it("retries the primary once when it fails before any token", async () => {
    const primary = provider("p", async (onToken, call) => {
      if (call === 1) throw new Error("openai 429");
      onToken("नमस्ते");
      return "नमस्ते";
    });
    const mt = new ResilientMtProvider(primary, undefined, { retryDelayMs: 1 });
    const tokens: string[] = [];
    expect(await mt.translate(req, (t) => tokens.push(t))).toBe("नमस्ते");
    expect(primary.calls).toBe(2);
    expect(tokens).toEqual(["नमस्ते"]);
    expect(mt.retries).toBe(1);
  });

  it("falls back to the secondary when the primary keeps failing or stalls", async () => {
    const primary = provider("p", () => new Promise<string>(() => {}));
    const fallback = provider("f", async (onToken) => {
      onToken("नमस्ते");
      return "नमस्ते";
    });
    const mt = new ResilientMtProvider(primary, fallback, {
      retryDelayMs: 1,
      firstTokenTimeoutMs: 20,
    });
    expect(await mt.translate(req, () => {})).toBe("नमस्ते");
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);
    expect(mt.fallbacks).toBe(1);
  });

  it("never switches providers once tokens have been streamed", async () => {
    const primary = provider("p", async (onToken) => {
      onToken("नम");
      throw new Error("connection reset");
    });
    const fallback = provider("f", async () => "x");
    const mt = new ResilientMtProvider(primary, fallback, { retryDelayMs: 1 });
    await expect(mt.translate(req, () => {})).rejects.toThrow("connection reset");
    expect(fallback.calls).toBe(0);
  });
});
