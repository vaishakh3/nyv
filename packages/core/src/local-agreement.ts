/**
 * LocalAgreement-n commit policy (Liu et al. 2020, used by whisper_streaming).
 *
 * Streaming ASR revises its hypothesis as more audio arrives. Words are "committed" once the last n
 * hypotheses agree on them; committed words are never revised, so downstream stages can act on them
 * without risk of audible retractions.
 */
export class LocalAgreement {
  private readonly history: string[][] = [];
  private committedCount = 0;

  constructor(private readonly n = 2) {
    if (n < 1) throw new RangeError("n must be >= 1");
  }

  /** Feed the next hypothesis for the current chunk; returns the words newly committed by this update. */
  push(words: readonly string[]): string[] {
    this.history.push([...words]);
    if (this.history.length > this.n) this.history.shift();
    if (this.history.length < this.n) return [];

    const first = this.history[0] as string[];
    let agree = first.length;
    for (let h = 1; h < this.history.length; h++) {
      const other = this.history[h] as string[];
      agree = Math.min(agree, other.length);
      for (let i = 0; i < agree; i++) {
        if (normalize(first[i] as string) !== normalize(other[i] as string)) {
          agree = i;
          break;
        }
      }
    }

    if (agree <= this.committedCount) return [];
    const latest = this.history[this.history.length - 1] as string[];
    const fresh = latest.slice(this.committedCount, agree);
    this.committedCount = agree;
    return fresh;
  }

  /** Words committed so far from the latest hypothesis. */
  get committed(): number {
    return this.committedCount;
  }

  /** The current chunk is final: everything beyond the committed count is committed too. */
  finalize(words: readonly string[]): string[] {
    const fresh = words.slice(this.committedCount);
    this.reset();
    return [...fresh];
  }

  reset(): void {
    this.history.length = 0;
    this.committedCount = 0;
  }
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
