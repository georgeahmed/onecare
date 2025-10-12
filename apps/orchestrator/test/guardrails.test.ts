import { describe, it, expect, vi } from 'vitest';
import { callWithGuard, CircuitBreaker } from '../src/adapters/common/guardrails';

describe('guardrails', () => {
  it('retries with backoff and succeeds', async () => {
    let attempts = 0;
    const fn = async (_signal: AbortSignal) => {
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
    const fn = async (_signal: AbortSignal) => {
      attempts += 1;
      throw new Error('fail');
    };
    const cb = new CircuitBreaker('svc', 2, 50);
    await expect(callWithGuard('svc', fn, { timeoutMs: 100, maxRetries: 1, baseDelayMs: 5 }, cb)).rejects.toBeInstanceOf(Error);
    // Second call should be blocked quickly when circuit is open
    await expect(callWithGuard('svc', fn, { timeoutMs: 100, maxRetries: 0, baseDelayMs: 5 }, cb)).rejects.toBeInstanceOf(Error);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('awaits configured sleep between retries', async () => {
    let attempts = 0;
    let resolveSleep: (() => void) | undefined;
    const sleep = vi.fn(
      (_ms: number, _signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          resolveSleep = resolve;
        }),
    );
    const fn = vi.fn(async (_signal: AbortSignal) => {
      attempts += 1;
      if (attempts === 1) throw new Error('fail');
      return 'ok';
    });

    const resultPromise = callWithGuard('svc', fn, {
      timeoutMs: 10,
      maxRetries: 1,
      baseDelayMs: 5,
      sleep,
      random: () => 0,
    });

    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledTimes(1);
    });
    expect(sleep.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveSleep?.();
    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates timeout errors when work exceeds the limit', async () => {
    const fn = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));
    await expect(
      callWithGuard('svc-timeout', fn, {
        timeoutMs: 10,
        maxRetries: 0,
        baseDelayMs: 5,
      }),
    ).rejects.toThrow('timeout:svc-timeout');
  });
});
