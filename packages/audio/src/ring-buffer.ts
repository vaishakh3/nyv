/** Fixed-capacity Float32 FIFO. Overwrites the oldest samples when full. */
export class RingBuffer {
  private readonly buf: Float32Array;
  private readIdx = 0;
  private writeIdx = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  get free(): number {
    return this.capacity - this.count;
  }

  write(data: Float32Array): number {
    let dropped = 0;
    for (let i = 0; i < data.length; i++) {
      this.buf[this.writeIdx] = data[i] as number;
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      if (this.count === this.capacity) {
        this.readIdx = (this.readIdx + 1) % this.capacity;
        dropped++;
      } else {
        this.count++;
      }
    }
    return dropped;
  }

  /** Reads up to out.length samples; returns the number read. Unfilled tail is zeroed. */
  read(out: Float32Array): number {
    const n = Math.min(out.length, this.count);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.readIdx] as number;
      this.readIdx = (this.readIdx + 1) % this.capacity;
    }
    for (let i = n; i < out.length; i++) out[i] = 0;
    this.count -= n;
    return n;
  }

  /** Peek without consuming. */
  peek(out: Float32Array, offset = 0): number {
    const n = Math.max(0, Math.min(out.length, this.count - offset));
    let idx = (this.readIdx + offset) % this.capacity;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[idx] as number;
      idx = (idx + 1) % this.capacity;
    }
    for (let i = n; i < out.length; i++) out[i] = 0;
    return n;
  }

  skip(n: number): number {
    const k = Math.min(n, this.count);
    this.readIdx = (this.readIdx + k) % this.capacity;
    this.count -= k;
    return k;
  }

  clear(): void {
    this.readIdx = 0;
    this.writeIdx = 0;
    this.count = 0;
  }
}
