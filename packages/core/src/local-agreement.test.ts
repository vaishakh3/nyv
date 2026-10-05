import { describe, expect, it } from "vitest";
import { LocalAgreement } from "./local-agreement.js";

describe("LocalAgreement", () => {
  it("commits only the prefix two consecutive hypotheses agree on", () => {
    const la = new LocalAgreement(2);
    expect(la.push(["i", "will"])).toEqual([]);
    expect(la.push(["i", "will", "send"])).toEqual(["i", "will"]);
    expect(la.push(["i", "will", "send", "you"])).toEqual(["send"]);
    // Revision of an uncommitted word commits nothing new
    expect(la.push(["i", "will", "send", "your"])).toEqual([]);
    expect(la.push(["i", "will", "send", "your", "report"])).toEqual(["your"]);
  });

  it("never retracts a commitment even if later hypotheses disagree", () => {
    const la = new LocalAgreement(2);
    la.push(["hello", "world"]);
    la.push(["hello", "world", "today"]);
    expect(la.committed).toBe(2);
    expect(la.push(["hallo", "welt"])).toEqual([]);
    expect(la.committed).toBe(2);
  });

  it("ignores case and punctuation when comparing", () => {
    const la = new LocalAgreement(2);
    la.push(["Hello", "world"]);
    expect(la.push(["hello,", "World."])).toEqual(["hello,", "World."]);
  });

  it("finalize commits the rest and resets", () => {
    const la = new LocalAgreement(2);
    la.push(["a", "b"]);
    la.push(["a", "b", "c"]);
    expect(la.finalize(["a", "b", "c", "d"])).toEqual(["c", "d"]);
    expect(la.committed).toBe(0);
    expect(la.push(["x"])).toEqual([]);
  });
});
