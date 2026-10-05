/**
 * Segments are translated concurrently (pipelining is where the latency win is) but must be heard in
 * order. The sequencer releases audio for segment N only after segment N-1 has finished.
 */
export interface AudioSink {
  onSegmentStart(segmentId: number): void;
  onAudio(segmentId: number, pcm: Int16Array): void;
  onSegmentEnd(segmentId: number, durationMs: number): void;
}

export interface AudioSlot {
  push(pcm: Int16Array): void;
  end(): void;
}

interface Pending {
  chunks: Int16Array[];
  ended: boolean;
}

export class AudioSequencer {
  private readonly pending = new Map<number, Pending>();
  private nextId: number;
  private activeStarted = false;
  private activeSamples = 0;

  constructor(
    private readonly sink: AudioSink,
    private readonly sampleRate: number,
    firstSegmentId = 1,
  ) {
    this.nextId = firstSegmentId;
  }

  open(segmentId: number): AudioSlot {
    const p: Pending = { chunks: [], ended: false };
    this.pending.set(segmentId, p);
    return {
      push: (pcm) => {
        if (p.ended) return;
        p.chunks.push(pcm);
        this.drain();
      },
      end: () => {
        p.ended = true;
        this.drain();
      },
    };
  }

  /** Skip a segment that will never produce audio (e.g. translation failed before a slot was opened). */
  skip(segmentId: number): void {
    const p = this.pending.get(segmentId) ?? { chunks: [], ended: true };
    p.ended = true;
    this.pending.set(segmentId, p);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const p = this.pending.get(this.nextId);
      if (!p) return;
      while (p.chunks.length > 0) {
        const pcm = p.chunks.shift() as Int16Array;
        if (pcm.length === 0) continue;
        if (!this.activeStarted) {
          this.activeStarted = true;
          this.sink.onSegmentStart(this.nextId);
        }
        this.activeSamples += pcm.length;
        this.sink.onAudio(this.nextId, pcm);
      }
      if (!p.ended) return;
      if (this.activeStarted) {
        this.sink.onSegmentEnd(this.nextId, (this.activeSamples / this.sampleRate) * 1000);
      }
      this.pending.delete(this.nextId);
      this.nextId++;
      this.activeStarted = false;
      this.activeSamples = 0;
    }
  }
}
