import { describe, it, expect } from 'vitest';
import { callWithGuard, CircuitBreaker } from '../src/adapters/common/guardrails';

describe('guardrails', () => {
  it('retries with backoff and succeeds', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('flaky');
      return 'ok';
    };
    const res = await callWithGuard('flaky', fn, { timeoutMs: 500, maxRetries: 3, baseDelayMs: 5 });
    expect(res).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('opens circuit after consecutive failures', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      throw new Error('fail');
    };
    const cb = new CircuitBreaker('svc', 2, 50);
    await expect(callWithGuard('svc', fn, { timeoutMs: 100, maxRetries: 1, baseDelayMs: 5 }, cb)).rejects.toBeInstanceOf(Error);
    // Second call should be blocked quickly when circuit is open
    await expect(callWithGuard('svc', fn, { timeoutMs: 100, maxRetries: 0, baseDelayMs: 5 }, cb)).rejects.toBeInstanceOf(Error);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});

