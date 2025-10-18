import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope, type AuditEvent } from '@onecare/events';
import { createCounter, logger } from '@onecare/observability';
import { publishWithGuard, type PublishOptions } from '../adapters/bus.adapter';

const enqueueCounter = createCounter('ics.audit.spool_enqueued_total');
const publishCounter = createCounter('ics.audit.spool_published_total');
const dropCounter = createCounter('ics.audit.spool_dropped_total');

export interface AuditSpoolOptions {
  maxSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  publishOptions?: PublishOptions;
  sleep?: (ms: number) => Promise<void>;
}

interface AuditQueueItem {
  event: AuditEvent;
  correlationId?: string;
  attempts: number;
  enqueuedAt: number;
}

export interface AuditSpoolStats {
  enqueued: number;
  published: number;
  dropped: number;
  inFlight: number;
  queued: number;
}

export class AuditSpool {
  private readonly queue: AuditQueueItem[] = [];
  private readonly maxSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private draining = false;
  private readonly drainResolvers: Array<() => void> = [];
  private published = 0;
  private dropped = 0;
  private enqueued = 0;

  constructor(
    private readonly busProvider: () => MessageBus | undefined,
    private readonly options: AuditSpoolOptions = {},
  ) {
    this.maxSize = Math.max(1, Math.floor(options.maxSize ?? 256));
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.retryDelayMs = Math.max(10, Math.floor(options.retryDelayMs ?? 250));
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get size(): number {
    return this.queue.length;
  }

  getStats(): AuditSpoolStats {
    return {
      enqueued: this.enqueued,
      published: this.published,
      dropped: this.dropped,
      inFlight: this.draining ? 1 : 0,
      queued: this.queue.length,
    };
  }

  enqueue(event: AuditEvent, correlationId?: string): void {
    if (this.queue.length >= this.maxSize) {
      this.dropped += 1;
      dropCounter.add(1, { reason: 'overflow' });
      logger.error('ics.audit.spool_overflow', {
        queueSize: this.queue.length,
        maxSize: this.maxSize,
        eventType: event.type,
      });
      return;
    }
    const item: AuditQueueItem = {
      event,
      correlationId,
      attempts: 0,
      enqueuedAt: Date.now(),
    };
    this.queue.push(item);
    this.enqueued += 1;
    enqueueCounter.add(1, { eventType: event.type });
    void this.processQueue();
  }

  async flush(): Promise<void> {
    if (!this.draining && this.queue.length === 0) return;
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        const bus = this.busProvider();
        if (!bus) {
          logger.warn('ics.audit.spool_bus_unavailable', {
            queued: this.queue.length,
            retryDelayMs: this.retryDelayMs,
          });
          await this.sleep(this.retryDelayMs);
          continue;
        }
        try {
          const envelope = createEnvelope(Topics.audit.event, item.event, item.correlationId);
          await publishWithGuard(bus, envelope.topic, envelope, item.correlationId, this.options.publishOptions);
          this.queue.shift();
          this.published += 1;
          publishCounter.add(1, { eventType: item.event.type });
          logger.debug('ics.audit.spool_published', {
            eventType: item.event.type,
            correlationId: item.correlationId,
            queued: this.queue.length,
          });
        } catch (error) {
          item.attempts += 1;
          logger.error('ics.audit.spool_publish_failed', {
            eventType: item.event.type,
            attempts: item.attempts,
            correlationId: item.correlationId,
            reason: error instanceof Error ? error.message : String(error),
          });
          if (item.attempts >= this.maxAttempts) {
            this.queue.shift();
            this.dropped += 1;
            dropCounter.add(1, { reason: 'attempts_exceeded' });
            logger.error('ics.audit.spool_drop', {
              eventType: item.event.type,
              attempts: item.attempts,
            });
          }
          await this.sleep(this.retryDelayMs);
        }
      }
    } finally {
      this.draining = false;
      while (this.drainResolvers.length > 0) {
        const resolve = this.drainResolvers.shift();
        resolve?.();
      }
    }
  }
}
