import type { TtsOptions, TtsProvider } from "@fyv/core";

/** Picks a TTS provider per target language, so a new language's vendor never touches the other paths. */
export class RoutedTtsProvider implements TtsProvider {
  readonly name: string;
  readonly outputSampleRate: number;
  constructor(
    private readonly routes: ReadonlyArray<{
      match: (language: string) => boolean;
      provider: TtsProvider;
    }>,
    private readonly fallback: TtsProvider,
  ) {
    this.outputSampleRate = fallback.outputSampleRate;
    for (const r of routes) {
      if (r.provider.outputSampleRate !== this.outputSampleRate)
        throw new Error(
          `routed tts: ${r.provider.name} outputs ${r.provider.outputSampleRate} Hz, fallback ${fallback.name} ${this.outputSampleRate} Hz`,
        );
    }
    this.name = [...routes.map((r) => r.provider.name), fallback.name].join("|");
  }

  private pick(language: string): TtsProvider {
    return this.routes.find((r) => r.match(language))?.provider ?? this.fallback;
  }

  warm(opts: TtsOptions): void {
    this.pick(opts.language).warm?.(opts);
  }

  synthesize(
    text: AsyncIterable<string>,
    opts: TtsOptions,
    onAudio: (pcm: Int16Array) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.pick(opts.language).synthesize(text, opts, onAudio, signal);
  }
}
