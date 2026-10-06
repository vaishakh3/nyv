import type { AsrEvent, AsrProvider, AsrStartOptions, AsrStream } from "@fyv/core";

/** Picks an ASR provider per source language (e.g. an English-only fast model with a multilingual fallback). */
export class RoutedAsrProvider implements AsrProvider {
  readonly name: string;
  constructor(
    private readonly routes: ReadonlyArray<{
      match: (language: string) => boolean;
      provider: AsrProvider;
    }>,
    private readonly fallback: AsrProvider,
  ) {
    this.name = [...routes.map((r) => r.provider.name), fallback.name].join("|");
  }

  start(opts: AsrStartOptions, onEvent: (e: AsrEvent) => void): Promise<AsrStream> {
    const route = this.routes.find((r) => r.match(opts.language));
    return (route?.provider ?? this.fallback).start(opts, onEvent);
  }
}
