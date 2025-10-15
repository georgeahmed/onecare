import { setTimeout as delay } from 'node:timers/promises';
import { logger } from '@onecare/observability';
import type { AuditEvent as LedgerEvent, AuditLedger } from '@onecare/ports';

interface AuditDetails {
  correlationId?: string;
  payload?: unknown;
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
      logger.warn('audit.buffer.drop', {
        reason: 'queue_full',
        size: this.queue.length,
        type: event.type,
      });
      return;
    }
    this.queue.push({ event, attempts: 0 });
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
        try {
          await this.writeWithTimeout(current.event);
        } catch (error) {
          const attempts = current.attempts + 1;
          if (attempts >= this.options.maxAttempts) {
            logger.error('audit.write.dropped', {
              type: current.event.type,
              attempts,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          current.attempts = attempts;
          const delayMs = Math.min(
            this.options.baseRetryDelayMs * 2 ** (attempts - 1),
            this.options.maxRetryDelayMs,
          );
          logger.warn('audit.write.retry', {
            type: current.event.type,
            attempts,
            delayMs,
            reason: error instanceof Error ? error.message : String(error),
          });
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
      this.schedule();
    }, delayMs);
    if (typeof handle === 'object' && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
  }

  private async writeWithTimeout(event: LedgerEvent): Promise<void> {
    if (this.options.writeTimeoutMs <= 0) {
      await this.base.write(event);
      return;
    }
    const timeoutError = new Error('audit_write_timeout');
    await Promise.race([
      this.base.write(event),
      delay(this.options.writeTimeoutMs).then(() => {
        throw timeoutError;
      }),
    ]);
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
  return {
    type,
    ts: new Date().toISOString(),
    correlationId: details.correlationId,
    payload: details.payload,
  };
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
