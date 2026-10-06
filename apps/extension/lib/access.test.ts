import { describe, expect, it } from "vitest";
import { describeAccess, quotaUrl } from "./access.js";

describe("access", () => {
  it("derives the quota URL from the relay socket URL", () => {
    expect(quotaUrl("wss://relay.nyv.si/v1/session", "a b")).toBe(
      "https://relay.nyv.si/v1/quota?token=a%20b",
    );
    expect(quotaUrl("ws://localhost:8787/v1/session", "")).toBe("http://localhost:8787/v1/quota");
  });

  it("describes remaining budget", () => {
    expect(describeAccess(undefined)).toBe("Access code accepted.");
    expect(describeAccess({ dailyMinutes: 90, remainingMinutes: 42, resetsInMinutes: 100 })).toBe(
      "42 of 90 min left today",
    );
    expect(describeAccess({ dailyMinutes: 90, remainingMinutes: 0, resetsInMinutes: 100 })).toBe(
      "Today's 90 minutes are used up · resets in 2 h",
    );
  });
});
