import { describe, expect, it } from "vitest";
import { Quota } from "./quota.js";

describe("Quota", () => {
  it("is unlimited when disabled", () => {
    const q = new Quota(0);
    q.consume("a", 1e9);
    expect(q.enabled).toBe(false);
    expect(q.remainingMs("a")).toBe(Number.POSITIVE_INFINITY);
  });

  it("tracks usage per principal and clamps at zero", () => {
    const q = new Quota(60_000, () => Date.UTC(2026, 0, 1, 12));
    expect(q.remainingMs("a")).toBe(60_000);
    q.consume("a", 45_000);
    q.consume("b", 10_000);
    expect(q.remainingMs("a")).toBe(15_000);
    expect(q.remainingMs("b")).toBe(50_000);
    q.consume("a", 30_000);
    expect(q.remainingMs("a")).toBe(0);
  });

  it("resets at UTC midnight", () => {
    let t = Date.UTC(2026, 0, 1, 23, 30);
    const q = new Quota(60_000, () => t);
    q.consume("a", 60_000);
    expect(q.remainingMs("a")).toBe(0);
    expect(q.resetsInMs()).toBe(30 * 60_000);
    t = Date.UTC(2026, 0, 2, 0, 1);
    expect(q.remainingMs("a")).toBe(60_000);
  });
});
