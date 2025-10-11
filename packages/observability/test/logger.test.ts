import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../src/logger';

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
});
