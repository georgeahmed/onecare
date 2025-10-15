import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLedger, AuditEvent as LedgerAuditEvent } from '@onecare/ports';
import { logger } from '@onecare/observability';
import {
  createAuditEvent,
  flushAuditLedgerForTest,
  getAuditLedger,
  resetAuditLedger,
  setAuditLedger,
} from '../src/adapters/audit';

describe('BufferedAuditLedger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetAuditLedger();
  });

  it('retries failed writes with backoff and eventually succeeds', async () => {
    const stubWrite = vi
      .fn<AuditLedger['write']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(async (_event: LedgerAuditEvent) => {
        return;
      });

    const stubLedger: AuditLedger = {
      write: stubWrite,
    };

    setAuditLedger(stubLedger, {
      buffered: true,
      bufferOptions: {
        baseRetryDelayMs: 10,
        maxRetryDelayMs: 10,
        writeTimeoutMs: 50,
        maxAttempts: 3,
      },
    });

    const ledger = getAuditLedger();
    await ledger.write(createAuditEvent('test.retry'));

    await vi.advanceTimersByTimeAsync(20);
    await flushAuditLedgerForTest();

    expect(stubWrite).toHaveBeenCalledTimes(2);
    expect(stubWrite.mock.calls[1]?.[0]?.type).toBe('test.retry');
  });

  it('drops events when the buffer is full', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stubWrite = vi.fn<AuditLedger['write']>().mockResolvedValue(undefined);
    const stubLedger: AuditLedger = { write: stubWrite };

    setAuditLedger(stubLedger, {
      buffered: true,
      bufferOptions: {
        maxQueueSize: 1,
        baseRetryDelayMs: 10,
        maxRetryDelayMs: 10,
        writeTimeoutMs: 0,
      },
    });

    const ledger = getAuditLedger();
    ledger.write(createAuditEvent('test.full.1')).catch(() => {});
    await ledger.write(createAuditEvent('test.full.2'));

    await flushAuditLedgerForTest();

    const dropLogged = warnSpy.mock.calls.some((call) => call[0] === 'audit.buffer.drop');
    expect(dropLogged).toBe(true);
    expect(stubWrite).toHaveBeenCalledTimes(1);
  });
});
