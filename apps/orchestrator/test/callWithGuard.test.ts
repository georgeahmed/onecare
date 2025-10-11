import { describe, it, expect, vi } from 'vitest';
import { callWithGuard } from '../src/adapters/services/callWithGuard';

describe('callWithGuard', () => {
  it('returns on success without retries', async () => {
    const res = await callWithGuard('svc', async () => 42, { now: () => 0, sleep: async () => {} });
    expect(res).toBe(42);
  });

  it('retries on timeout then succeeds', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const res = await callWithGuard(
      'svc2',
      async (signal) => {
        calls++;
        if (calls === 1) {
          // simulate timeout by ignoring signal and throwing timeout
          const e: any = new Error('ETIMEDOUT');
          e.code = 'ETIMEDOUT';
          throw e;
        }
        return 'ok';
      },
      { now: () => 0, sleep, maxRetries: 2, baseDelayMs: 1 }
    );
    expect(res).toBe('ok');
    expect(calls).toBe(2);
  });

  it('opens circuit after repeated failures', async () => {
    const sleep = async () => {};
    const failing = async () => {
      const e: any = new Error('ECONNRESET');
      e.code = 'ECONNRESET';
      throw e;
    };
    await expect(
      callWithGuard('svc3', failing, { now: () => 0, sleep, cbFailureThreshold: 1, maxRetries: 0 })
    ).rejects.toBeTruthy();
    // second call immediately yields circuit_open
    await expect(
      callWithGuard('svc3', failing, { now: () => 0, sleep, cbFailureThreshold: 1, maxRetries: 0 })
    ).rejects.toMatchObject({ code: 'circuit_open' });
  });
});

