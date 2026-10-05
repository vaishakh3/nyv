/** Push-based producer, pull-based async-iterable consumer; bridges MT token callbacks into TTS input. */
export class TextQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private waiting: ((r: IteratorResult<string>) => void) | undefined;
  private closed = false;
  private failure: unknown;

  push(chunk: string): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: chunk, done: false });
    } else {
      this.items.push(chunk);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    this.failure = err;
    this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        if (this.items.length > 0)
          return Promise.resolve({ value: this.items.shift() as string, done: false });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}
