// A generic flush queue used for both events and spans. Buffers items, flushes
// when the buffer reaches `flushAt` or `flushInterval` elapses, and re-queues
// the batch on send failure so delivery is at-least-once across transient errors.
export interface QueueOptions<T> {
  flushAt: number;
  flushInterval: number;
  /** Sends one batch. Must reject on failure so the batch is re-queued. */
  send: (items: T[]) => Promise<void>;
  /** Called when a flush ultimately fails (after the send rejects). */
  onError?: (error: unknown, items: T[]) => void;
  debug?: boolean;
  label?: string;
}

export class FlushQueue<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly opts: QueueOptions<T>) {}

  enqueue(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.opts.flushAt) {
      void this.flush();
      return;
    }
    this.scheduleTimer();
  }

  /** Drains the buffer and sends it. Concurrent calls share the in-flight flush
   * so we never double-send the same batch. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.clearTimer();
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    this.flushing = this.opts
      .send(batch)
      .catch((error) => {
        // Re-queue at the front so ordering is roughly preserved, then surface.
        this.buffer = [...batch, ...this.buffer];
        this.log(`flush failed, re-queued ${batch.length} item(s)`);
        this.opts.onError?.(error, batch);
      })
      .finally(() => {
        this.flushing = null;
      });

    return this.flushing;
  }

  /** Number of buffered items not yet sent. */
  size(): number {
    return this.buffer.length;
  }

  /** Stops the interval timer. Does not flush — call `flush()` first for a clean drain. */
  stop(): void {
    this.clearTimer();
  }

  private scheduleTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushInterval);
    // Don't keep a Node process alive just for the flush timer.
    const t = this.timer as { unref?: () => void };
    t.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private log(message: string): void {
    if (this.opts.debug) {
      console.debug(`[pulse-js${this.opts.label ? `:${this.opts.label}` : ""}] ${message}`);
    }
  }
}
