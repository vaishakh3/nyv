/** Hosted-relay access checks. The relay exposes `GET /v1/quota?token=` (CORS `*`) next to the WebSocket. */

export interface AccessInfo {
  /** null = the relay does not meter this code. */
  dailyMinutes: number | null;
  remainingMinutes: number | null;
  resetsInMinutes: number | null;
}

export function quotaUrl(relayUrl: string, token: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/v1/quota";
  u.search = token ? `?token=${encodeURIComponent(token)}` : "";
  return u.toString();
}

/**
 * Validates the access code and returns the remaining budget. Throws a user-facing Error when the
 * code is rejected or the relay is unreachable; an older relay without the endpoint passes through.
 */
export async function checkAccess(
  relayUrl: string,
  token: string,
): Promise<AccessInfo | undefined> {
  let res: Response;
  try {
    res = await fetch(quotaUrl(relayUrl, token), { cache: "no-store" });
  } catch {
    throw new Error(`Can't reach the relay at ${new URL(relayUrl).host}. Check your connection.`);
  }
  if (res.status === 401)
    throw new Error(token ? "Access code not recognised." : "Enter your access code to start.");
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Relay error (${res.status}). Try again shortly.`);
  const body = (await res.json()) as Partial<AccessInfo> & { ok?: boolean };
  return {
    dailyMinutes: body.dailyMinutes ?? null,
    remainingMinutes: body.remainingMinutes ?? null,
    resetsInMinutes: body.resetsInMinutes ?? null,
  };
}

export function describeAccess(a: AccessInfo | undefined): string {
  if (!a || a.remainingMinutes === null || a.dailyMinutes === null) return "Access code accepted.";
  if (a.remainingMinutes <= 0) {
    const h = Math.ceil((a.resetsInMinutes ?? 0) / 60);
    return `Today's ${a.dailyMinutes} minutes are used up · resets in ${h} h`;
  }
  return `${a.remainingMinutes} of ${a.dailyMinutes} min left today`;
}
