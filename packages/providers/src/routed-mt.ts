import type { MtProvider, MtRequest } from "@fyv/core";

/** Picks an MT provider per target language (e.g. a larger model for languages the small one is weak in). */
export class RoutedMtProvider implements MtProvider {
  readonly name: string;
  constructor(
    private readonly routes: ReadonlyArray<{
      match: (targetLang: string) => boolean;
      provider: MtProvider;
    }>,
    private readonly fallback: MtProvider,
  ) {
    this.name = [...routes.map((r) => r.provider.name), fallback.name].join("|");
  }

  warm(): void {
    this.fallback.warm?.();
    for (const r of this.routes) r.provider.warm?.();
  }

  translate(
    req: MtRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const route = this.routes.find((r) => r.match(req.targetLang));
    return (route?.provider ?? this.fallback).translate(req, onToken, signal);
  }
}
