import type { GlossaryEntry, MtContext } from "./types.js";

/** Rolling bilingual history fed to the translator so terminology, formality and gender stay consistent. */
export class ContextWindow {
  private readonly pairs: { source: string; target: string }[] = [];

  constructor(
    private readonly glossary: ReadonlyArray<GlossaryEntry> = [],
    private readonly maxPairs = 8,
  ) {}

  push(source: string, target: string): void {
    this.pairs.push({ source, target });
    if (this.pairs.length > this.maxPairs) this.pairs.shift();
  }

  snapshot(): MtContext {
    return { history: [...this.pairs], glossary: this.glossary };
  }
}
