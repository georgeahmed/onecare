import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../src/logger';
import { getCorrelationId, setCorrelationId, withCorrelationContext } from '../src/otel';

const consoleSpy = vi.spyOn(console, 'log');

function getLastPayload() {
  const lastCall = consoleSpy.mock.calls.at(-1);
  if (!lastCall) throw new Error('Expected console.log to be called');
  const [argument] = lastCall;
  if (typeof argument !== 'string') throw new Error('Expected console.log to receive a JSON string');
  return JSON.parse(argument) as Record<string, unknown>;
}

describe('logger redaction', () => {
  beforeEach(() => {
    consoleSpy.mockImplementation(() => {});
    consoleSpy.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockReset();
  });

  afterAll(() => {
    consoleSpy.mockRestore();
  });

  it('redacts email addresses in fields', () => {
    log('info', 'testing email', { email: 'alice@example.com' });

    const payload = getLastPayload();
    expect(payload.email).toBe('[REDACTED]');
  });

  it('redacts phone numbers in fields', () => {
    log('info', 'testing phone', { phone: '(555) 123-4567' });

    const payload = getLastPayload();
    expect(payload.phone).toBe('[REDACTED]');
  });

  it('redacts tokens in both messages and fields', () => {
    log('info', 'token=super-secret-token', { token: 'sk_live_123456789' });

    const payload = getLastPayload();
    expect(payload.token).toBe('[REDACTED]');
    expect(payload.msg).toBe('token=[REDACTED]');
  });

  it('retains correlation identifiers in top-level and nested fields', () => {
    log('info', 'incoming request', {
      'x-correlation-id': 'corr-123',
      headers: { 'X-Request-Id': 'req-999', Authorization: 'Bearer abc' },
    });

    const payload = getLastPayload();
    expect(payload['x-correlation-id']).toBe('corr-123');
    expect((payload.headers as Record<string, unknown>)['X-Request-Id']).toBe('req-999');
    expect((payload.headers as Record<string, unknown>).Authorization).toBe('[REDACTED]');
  });

  it('preserves structured objects after redaction', () => {
    log('info', 'object field', { details: { safe: 'value', secretToken: 'abc', nested: { email: 'user@example.com' } } });

    const payload = getLastPayload();
    expect(payload.details).toMatchObject({
      safe: 'value',
      secretToken: '[REDACTED]',
      nested: { email: '[REDACTED]' },
    });
  });

  it('keeps practice identifiers for operational visibility', () => {
    log('info', 'practice config applied', { practiceId: 'demo-practice' });

    const payload = getLastPayload();
    expect(payload.practiceId).toBe('demo-practice');
  });

  it('does not redact non-identifier fields that contain id as a suffix', () => {
    log('info', 'flag valid status', { valid: true, invalid: false });

    const payload = getLastPayload();
    expect(payload.valid).toBe(true);
    expect(payload.invalid).toBe(false);
  });

  it('preserves structured fields after redaction', () => {
    log('info', 'structured payload', {
      portal: {
        practiceId: 'demo-practice',
        token: 'sk_live_123',
        slots: [1, 2, 3],
      },
    });

    const payload = getLastPayload();
    expect(payload.portal).toEqual({
      practiceId: 'demo-practice',
      token: '[REDACTED]',
      slots: [1, 2, 3],
    });
  });
});

describe('correlation context', () => {
  beforeEach(() => {
    setCorrelationId(undefined);
  });

  it('does not leak correlation ids between contexts', () => {
    withCorrelationContext(() => {
      setCorrelationId('corr-a');
      expect(getCorrelationId()).toBe('corr-a');
    });
    expect(getCorrelationId()).toBeUndefined();
  });

  it('propagates correlation id within async operations', async () => {
    await withCorrelationContext(async () => {
      setCorrelationId('corr-b');
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(getCorrelationId()).toBe('corr-b');
          resolve();
        }, 0);
      });
    });
    expect(getCorrelationId()).toBeUndefined();
  });

  it('preserves existing context when nesting withCorrelationContext', () => {
    withCorrelationContext(() => {
      setCorrelationId('outer');
      withCorrelationContext(() => {
        expect(getCorrelationId()).toBe('outer');
      });
      expect(getCorrelationId()).toBe('outer');
    });
  });
});
