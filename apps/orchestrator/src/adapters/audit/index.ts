import { setTimeout as sleep } from 'node:timers/promises';
import { logger, createCounter, createHistogram, redact as redactFields } from '@onecare/observability';
import type { AuditEvent as LedgerEvent, AuditLedger, AuditOutcome } from '@onecare/ports';
import { callWithGuard } from '../services/callWithGuard';

interface AuditDetails {
  correlationId?: string | null;
  actorRef?: string | null;
  subjectRef?: string | null;
  outcome?: AuditOutcome | null;
  reasonCode?: string | null;
  details?: Record<string, unknown> | null;
}

interface BufferedAuditLedgerOptions {
  maxQueueSize: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxAttempts: number;
  writeTimeoutMs: number;
}

interface BufferedEntry {
  event: LedgerEvent;
  attempts: number;
}

const writeOkCounter = createCounter('audit.write.ok');
const writeFailCounter = createCounter('audit.write.fail');
const queueDepthMetric = createHistogram('audit.queue.depth');
const queueDropCounter = createCounter('audit.queue.drop');

const DEFAULT_BUFFER_OPTIONS: BufferedAuditLedgerOptions = {
  maxQueueSize: 200,
  baseRetryDelayMs: 100,
  maxRetryDelayMs: 1_000,
  maxAttempts: 5,
  writeTimeoutMs: 500,
};

class BufferedAuditLedger implements AuditLedger {
  private readonly options: BufferedAuditLedgerOptions;
  private readonly queue: BufferedEntry[] = [];
  private processing = false;
  private scheduled = false;
  private pendingRetries = 0;

  constructor(
    private readonly base: AuditLedger,
    options?: Partial<BufferedAuditLedgerOptions>,
  ) {
    this.options = { ...DEFAULT_BUFFER_OPTIONS, ...(options ?? {}) };
  }

  async write(event: LedgerEvent): Promise<void> {
    if (this.queue.length >= this.options.maxQueueSize) {
      const dropped = this.queue.shift();
      queueDropCounter.add(1, { reason: 'queue_full' });
      logger.warn('audit.queue.drop', {
        reason: 'queue_full',
        droppedType: dropped?.event.type,
        droppedCorrelationId: dropped?.event.correlationId,
      });
      queueDepthMetric.record(this.queue.length);
    }
    this.queue.push({ event, attempts: 0 });
    queueDepthMetric.record(this.queue.length);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const current = this.queue.shift()!;
        queueDepthMetric.record(this.queue.length);
        current.attempts += 1;
        try {
          await this.writeOnce(current);
          writeOkCounter.add(1);
          logger.info('audit.write.ok', {
            type: current.event.type,
            attempts: current.attempts,
            correlationId: current.event.correlationId ?? undefined,
          });
        } catch (error) {
          writeFailCounter.add(1);
          const reason = error instanceof Error ? error.message : String(error);
          logger.warn('audit.write.fail', {
            type: current.event.type,
            attempts: current.attempts,
            correlationId: current.event.correlationId ?? undefined,
            reason,
          });
          if (current.attempts >= this.options.maxAttempts) {
            logger.error('audit.write.dropped', {
              type: current.event.type,
              attempts: current.attempts,
              correlationId: current.event.correlationId ?? undefined,
              reason,
            });
            queueDropCounter.add(1, { reason: 'max_attempts' });
            continue;
          }
          const delayMs = Math.min(
            this.options.baseRetryDelayMs * 2 ** (current.attempts - 1),
            this.options.maxRetryDelayMs,
          );
          this.scheduleRetry(current, delayMs);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private scheduleRetry(entry: BufferedEntry, delayMs: number): void {
    this.pendingRetries += 1;
    const handle = setTimeout(() => {
      this.pendingRetries = Math.max(0, this.pendingRetries - 1);
      this.queue.push(entry);
      queueDepthMetric.record(this.queue.length);
      logger.warn('audit.write.retry', {
        type: entry.event.type,
        attempts: entry.attempts,
        delayMs,
        correlationId: entry.event.correlationId ?? undefined,
      });
      this.schedule();
    }, delayMs);
    if (typeof handle === 'object' && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
  }

  private async writeOnce(entry: BufferedEntry): Promise<void> {
    const { event } = entry;
    if (this.options.writeTimeoutMs <= 0) {
      await this.base.write(event);
      return;
    }
    await callWithGuard(
      'audit.write',
      async (signal) => {
        if (signal.aborted) {
          const abortError = Object.assign(new Error('audit_write_aborted'), { code: 'audit_write_aborted' });
          throw abortError;
        }
        const abortPromise = new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('audit_write_timeout'), { code: 'audit_write_timeout' }));
            },
            { once: true },
          );
        });
        await Promise.race([this.base.write(event), abortPromise]);
      },
      {
        timeoutMs: this.options.writeTimeoutMs,
        baseDelayMs: this.options.baseRetryDelayMs,
        maxRetries: 0,
        correlationId: event.correlationId ?? undefined,
        sleep: (ms) => sleep(Math.min(ms, this.options.maxRetryDelayMs)),
      },
    );
  }

  async waitForIdle(): Promise<void> {
    while (this.processing || this.queue.length > 0 || this.pendingRetries > 0) {
      await Promise.resolve();
    }
  }
}

class ConsoleAuditLedger implements AuditLedger {
  async write(event: LedgerEvent): Promise<void> {
    logger.info('audit.ledger.write', {
      type: event.type,
      correlationId: event.correlationId,
    });
  }
}

let activeLedger: AuditLedger = new BufferedAuditLedger(new ConsoleAuditLedger());

export function createAuditEvent(type: string, details: AuditDetails = {}): LedgerEvent {
  const sanitizedDetails =
    details.details && Object.keys(details.details).length > 0
      ? (redactFields(details.details) as Record<string, unknown>)
      : null;
  const base = {
    type,
    ts: new Date().toISOString(),
    correlationId: details.correlationId ?? null,
    actorRef: details.actorRef ?? null,
    subjectRef: details.subjectRef ?? null,
    outcome: details.outcome ?? 'unknown',
    reasonCode: details.reasonCode ?? null,
  };
  const payload: Record<string, unknown> = {
    outcome: base.outcome,
    reasonCode: base.reasonCode,
    actorRef: base.actorRef,
    subjectRef: base.subjectRef,
    correlationId: base.correlationId,
    ...(sanitizedDetails ?? {}),
  };
  return {
    ...base,
    ...(sanitizedDetails ? { details: sanitizedDetails } : {}),
    payload,
  } as LedgerEvent & { payload: Record<string, unknown> };
}

export function getAuditLedger(): AuditLedger {
  return activeLedger;
}

interface SetAuditLedgerOptions {
  buffered?: boolean;
  bufferOptions?: Partial<BufferedAuditLedgerOptions>;
}

export function setAuditLedger(ledger: AuditLedger, options?: SetAuditLedgerOptions): void {
  if (options?.buffered) {
    activeLedger = new BufferedAuditLedger(ledger, options.bufferOptions);
    return;
  }
  activeLedger = ledger;
}

export function resetAuditLedger(): void {
  activeLedger = new BufferedAuditLedger(new ConsoleAuditLedger());
}

export async function flushAuditLedgerForTest(): Promise<void> {
  if (activeLedger instanceof BufferedAuditLedger) {
    await activeLedger.waitForIdle();
  }
}
