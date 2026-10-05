import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage, sessionConfig } from "./messages.js";

describe("control messages", () => {
  it("applies session defaults", () => {
    const cfg = sessionConfig.parse({ sourceLang: "en", targetLang: "hi" });
    expect(cfg.direction).toBe("inbound");
    expect(cfg.inputSampleRate).toBe(16000);
    expect(cfg.glossary).toEqual([]);
  });

  it("rejects unknown languages", () => {
    expect(() => sessionConfig.parse({ sourceLang: "en", targetLang: "xx" })).toThrow();
  });

  it("parses client and server messages", () => {
    const m = parseClientMessage(JSON.stringify({ type: "speech.end", tsMs: 10 }));
    expect(m.type).toBe("speech.end");
    const s = parseServerMessage(
      JSON.stringify({
        type: "transcript",
        segmentId: 1,
        text: "hello there",
        committed: "hello",
        final: false,
      }),
    );
    expect(s.type).toBe("transcript");
    expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  });
});
