import type { MtProvider, MtRequest } from "@fyv/core";

export interface ResilientMtOptions {
  /** Retry the primary once after this delay when it fails before producing a token (429, 5xx, network). */
  retryDelayMs?: number;
  /** Give up on the primary's first token after this long and switch to the fallback. */
  firstTokenTimeoutMs?: number;
}

/**
 * Keeps a segment from being lost when the MT vendor hiccups: a request that fails (or stalls) before
 * its first token is retried once, then handed to a fallback provider. Once tokens have streamed to
 * the listener we never switch (a second voice mid-sentence is worse than a short gap).
 */
export class ResilientMtProvider implements MtProvider {
  readonly name: string;
  private readonly retryDelayMs: number;
  private readonly firstTokenTimeoutMs: number;
  /** For the bench/report. */
  retries = 0;
  fallbacks = 0;

  constructor(
    private readonly primary: MtProvider,
    private readonly fallback: MtProvider | undefined,
    opts: ResilientMtOptions = {},
  ) {
    this.name = fallback ? `${primary.name}→${fallback.name}` : primary.name;
    this.retryDelayMs = opts.retryDelayMs ?? 150;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 2500;
  }

  warm(): void {
    this.primary.warm?.();
    this.fallback?.warm?.();
  }

  async translate(
    req: MtRequest,
    onToken: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const attempts: Array<{
      provider: MtProvider;
      delayMs: number;
      kind: "retry" | "fallback" | "first";
    }> = [
      { provider: this.primary, delayMs: 0, kind: "first" },
      { provider: this.primary, delayMs: this.retryDelayMs, kind: "retry" },
    ];
    if (this.fallback) attempts.push({ provider: this.fallback, delayMs: 0, kind: "fallback" });

    let lastErr: unknown;
    for (const attempt of attempts) {
      if (signal?.aborted) throw lastErr ?? new Error("aborted");
      if (attempt.delayMs > 0) await sleep(attempt.delayMs, signal);
      if (attempt.kind === "retry") this.retries++;
      if (attempt.kind === "fallback") this.fallbacks++;
      const result = await this.attempt(attempt.provider, req, onToken, signal);
      if (result.ok) return result.text;
      lastErr = result.error;
      if (result.streamed || signal?.aborted) throw result.error;
    }
    throw lastErr;
  }

  private async attempt(
    provider: MtProvider,
    req: MtRequest,
    onToken: (t: string) => void,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; text: string } | { ok: false; error: unknown; streamed: boolean }> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let streamed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!streamed) {
          ctl.abort();
          reject(new Error(`${provider.name}: no token within ${this.firstTokenTimeoutMs} ms`));
        }
      }, this.firstTokenTimeoutMs);
    });
    try {
      const text = await Promise.race([
        provider.translate(
          req,
          (t) => {
            streamed = true;
            onToken(t);
          },
          ctl.signal,
        ),
        stalled,
      ]);
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error, streamed };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
