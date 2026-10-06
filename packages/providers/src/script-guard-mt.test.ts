import type { MtProvider, MtRequest } from "@fyv/core";
import { describe, expect, it } from "vitest";
import { ScriptGuardMtProvider, stripperFor } from "./script-guard-mt.js";

const req = (targetLang: MtRequest["targetLang"]): MtRequest => ({
  text: "x",
  sourceLang: "en",
  targetLang,
  context: { history: [], glossary: [] },
});

function emitting(tokens: string[]): MtProvider {
  return {
    name: "fake",
    translate: async (_r, onToken) => {
      for (const t of tokens) onToken(t);
      return tokens.join("");
    },
  };
}

describe("ScriptGuardMtProvider", () => {
  it("drops a foreign-script word from the Malayalam token stream, keeping one space", async () => {
    const mt = new ScriptGuardMtProvider(emitting(["ഡ്രോപ്പ്", " ഓഫ്", " تقری", "باً", " ഇല്ലാതായി", "."]));
    const out: string[] = [];
    const full = await mt.translate(req("ml"), (t) => out.push(t));
    expect(full).toBe("ഡ്രോപ്പ് ഓഫ് ഇല്ലാതായി.");
    expect(out.join("")).toBe("ഡ്രോപ്പ് ഓഫ് ഇല്ലാതായി.");
    expect(mt.dropped).toBe(7);
  });

  it("keeps Latin names, digits, punctuation, ZWJ/ZWNJ and Malayalam chillu letters", () => {
    const strip = stripperFor("ml");
    const s = "പ്രിയയും Arjun‑ഉം 4:30‑ന് ചേരും, OK? സൈൻ‑അപ്പുകൾ 12% – “കൊള്ളാം”.";
    expect(strip?.(s)).toBe(s);
    expect(strip?.("ഇല്ല\u200d, ഇല്ല\u200c")).toBe("ഇല്ല\u200d, ഇല്ല\u200c");
  });

  it("swallows a degenerate run of wrong-script tokens entirely", async () => {
    const mt = new ScriptGuardMtProvider(emitting(["അത്", ...Array(200).fill(" 거의"), "."]));
    const out: string[] = [];
    expect(await mt.translate(req("ml"), (t) => out.push(t))).toBe("അത്.");
    expect(out).toEqual(["അത്", "."]);
  });

  it("guards Hindi too and passes unguarded languages through untouched", async () => {
    expect(stripperFor("hi")?.("नमस्ते quase 12 बजे")).toBe("नमस्ते quase 12 बजे");
    expect(stripperFor("hi")?.("नमस्ते تقریباً")).toBe("नमस्ते ");
    expect(stripperFor("es")).toBeUndefined();
    const mt = new ScriptGuardMtProvider(emitting(["hola ", "تقریباً"]));
    expect(await mt.translate(req("es"), () => {})).toBe("hola تقریباً");
  });
});
