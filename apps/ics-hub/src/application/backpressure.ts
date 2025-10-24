import { createCounter, createHistogram, logger } from '@onecare/observability';

const acquireCounter = createCounter('ics_backpressure_acquire_total');
const queueOverflowCounter = createCounter('ics_backpressure_queue_overflow_total');
const waitHistogram = createHistogram('ics_backpressure_wait_ms');

export interface ProcessingLimiterOptions {
  maxConcurrency: number;
  queueLimit?: number;
  highWatermark?: number;
  retryAfterSeconds?: number;
}

interface Waiter {
  label: string;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
}

export class ProcessingLimiter {
  private readonly queue: Waiter[] = [];
  private inflight = 0;
  private readonly queueLimit: number;
  private readonly highWatermark: number;
  private readonly retryAfterSeconds: number;
  private readonly maxConcurrency: number;
  private readonly idleResolvers: Array<() => void> = [];

  constructor(options: ProcessingLimiterOptions) {
    if (!Number.isFinite(options.maxConcurrency) || options.maxConcurrency <= 0) {
      throw new Error('ProcessingLimiter requires maxConcurrency > 0');
    }
    this.maxConcurrency = Math.floor(options.maxConcurrency);
    this.queueLimit = Math.max(this.maxConcurrency, Math.floor(options.queueLimit ?? this.maxConcurrency * 4));
    this.highWatermark = Math.max(this.maxConcurrency, Math.floor(options.highWatermark ?? this.maxConcurrency * 2));
    this.retryAfterSeconds = Math.max(1, Math.floor(options.retryAfterSeconds ?? 1));
  }

  get capacity(): number {
    return this.maxConcurrency;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get inflightCount(): number {
    return this.inflight;
  }

  get retryAfterSecondsValue(): number {
    return this.retryAfterSeconds;
  }

  isOverloaded(): boolean {
    return this.queue.length >= this.highWatermark;
  }

  async acquire(label: string): Promise<() => void> {
    acquireCounter.add(1);
    const now = Date.now();
    if (this.inflight < this.maxConcurrency) {
      this.inflight += 1;
      waitHistogram.record(0, { state: 'immediate' });
      return this.buildRelease();
    }

    if (this.queue.length >= this.queueLimit) {
      queueOverflowCounter.add(1);
      logger.error('ics.backpressure.queue_overflow', {
        queueSize: this.queue.length,
        queueLimit: this.queueLimit,
        label,
      });
      throw new Error('processing_queue_overflow');
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push({
        label,
        enqueuedAt: now,
        resolve,
      });
    });
  }

  async waitForIdle(): Promise<void> {
    if (this.inflight === 0 && this.queue.length === 0) {
      return;
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private buildRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.onRelease();
    };
  }

  private onRelease(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      this.inflight += 1;
      const waited = Math.max(0, Date.now() - waiter.enqueuedAt);
      waitHistogram.record(waited, { state: 'queued' });
      const release = this.buildRelease();
      waiter.resolve(release);
      logger.debug('ics.backpressure.dequeue', {
        label: waiter.label,
        queueSize: this.queue.length,
        waitedMs: waited,
      });
      return;
    }

    if (this.inflight === 0) {
      while (this.idleResolvers.length > 0) {
        const resolve = this.idleResolvers.shift();
        resolve?.();
      }
    }
  }
}
