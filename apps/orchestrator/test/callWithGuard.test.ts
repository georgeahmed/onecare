import { describe, it, expect, vi } from 'vitest';
import { callWithGuard, resetGuardBreakers } from '../src/adapters/services/callWithGuard';

beforeEach(() => {
  resetGuardBreakers();
});

describe('callWithGuard', () => {
  it('returns on success without retries', async () => {
    const res = await callWithGuard('svc', async (_signal: AbortSignal) => 42, {
      now: () => 0,
      sleep: async () => {},
      random: () => 0,
    });
    expect(res).toBe(42);
  });

  it('retries on timeout then succeeds', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const res = await callWithGuard(
      'svc2',
      async (_signal: AbortSignal) => {
        calls++;
        if (calls === 1) {
          // simulate timeout by ignoring signal and throwing timeout
          const e: any = new Error('ETIMEDOUT');
          e.code = 'ETIMEDOUT';
          throw e;
        }
        return 'ok';
      },
      { now: () => 0, sleep, maxRetries: 2, baseDelayMs: 1, random: () => 0 }
    );
    expect(res).toBe('ok');
    expect(calls).toBe(2);
  });

  it('opens circuit after repeated failures', async () => {
    const sleep = async () => {};
    const failing = async (_signal: AbortSignal) => {
      const e: any = new Error('ECONNRESET');
      e.code = 'ECONNRESET';
      throw e;
    };
    await expect(
      callWithGuard('svc3', failing, { now: () => 0, sleep, cbFailureThreshold: 1, maxRetries: 0, random: () => 0 })
    ).rejects.toBeTruthy();
    // second call immediately yields circuit_open
    await expect(
      callWithGuard('svc3', failing, { now: () => 0, sleep, cbFailureThreshold: 1, maxRetries: 0, random: () => 0 })
    ).rejects.toMatchObject({ code: 'circuit_open' });
  });

  it('half-open breaker after cooldown', async () => {
    const sleep = async () => {};
    const failing = async (_signal: AbortSignal) => {
      const e: any = new Error('ECONNRESET');
      e.code = 'ECONNRESET';
      throw e;
    };
    let current = 0;
    const now = () => current;

    await expect(
      callWithGuard('svc-half', failing, {
        now,
        sleep,
        cbFailureThreshold: 1,
        cbCooldownMs: 10_000,
        maxRetries: 0,
        random: () => 0,
      })
    ).rejects.toBeTruthy();

    let halfOpenCalled = false;
    current = 20_000;
    await expect(
      callWithGuard(
        'svc-half',
        async (_signal: AbortSignal) => {
          halfOpenCalled = true;
          return 'ok';
        },
        {
          now,
          sleep,
          cbFailureThreshold: 1,
          cbCooldownMs: 10_000,
          maxRetries: 0,
          random: () => 0,
        }
      )
    ).resolves.toBe('ok');

    expect(halfOpenCalled).toBe(true);
  });
});
