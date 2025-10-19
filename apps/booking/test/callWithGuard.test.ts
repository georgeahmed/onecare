import { describe, it, expect, beforeEach, vi } from 'vitest';
import { callWithGuard, resetBookingGuardBreakers } from '../src/adapters/callWithGuard';

function createNowStepper(step = 25): () => number {
  let current = 0;
  return () => {
    current += step;
    return current;
  };
}

describe('callWithGuard fault injection', () => {
  beforeEach(() => {
    resetBookingGuardBreakers();
    vi.useRealTimers();
  });

  it('retries timeout failures with deterministic backoff and succeeds once service recovers', async () => {
    const sleepCalls: number[] = [];
    let attempt = 0;
    const guardedCall = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) {
        const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        throw error;
      }
      return 'ok';
    });

    const result = await callWithGuard('gpconnect.create', guardedCall, {
      timeoutMs: 50,
      maxRetries: 2,
      baseDelayMs: 10,
      random: () => 0.4,
      now: createNowStepper(10),
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });

    expect(result).toBe('ok');
    expect(guardedCall).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([14, 24]);
  });

  it('opens the circuit after consecutive failures and recovers after cooldown', async () => {
    const transient = Object.assign(new Error('upstream unavailable'), {
      code: 'temporarily_unavailable',
    });
    let executions = 0;
    const guardedCall = vi.fn(async () => {
      executions += 1;
      if (executions <= 2) {
        throw transient;
      }
      return 'healthy';
    });

    let now = 0;
    const nowFn = () => {
      now += 200;
      return now;
    };

    const options = {
      maxRetries: 0,
      cbFailureThreshold: 2,
      cbCooldownMs: 1_000,
      random: () => 0,
      now: nowFn,
      sleep: () => Promise.resolve(),
    } as const;

    await expect(callWithGuard('gpconnect.health', guardedCall, options)).rejects.toBe(transient);
    await expect(callWithGuard('gpconnect.health', guardedCall, options)).rejects.toBe(transient);
    await expect(callWithGuard('gpconnect.health', guardedCall, options)).rejects.toMatchObject({
      code: 'circuit_open',
    });
    expect(guardedCall).toHaveBeenCalledTimes(2);

    now += 1_200;
    await expect(callWithGuard('gpconnect.health', guardedCall, options)).resolves.toBe('healthy');
    expect(guardedCall).toHaveBeenCalledTimes(3);

    await expect(callWithGuard('gpconnect.health', guardedCall, options)).resolves.toBe('healthy');
    expect(guardedCall).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-retryable failures', async () => {
    const fatal = Object.assign(new Error('bad request'), { code: 'bad_request' });
    const guardedCall = vi.fn(async () => {
      throw fatal;
    });
    const sleep = vi.fn();

    await expect(
      callWithGuard('gpconnect.create', guardedCall, {
        maxRetries: 3,
        baseDelayMs: 20,
        random: () => 0.3,
        now: createNowStepper(5),
        sleep,
      }),
    ).rejects.toBe(fatal);

    expect(guardedCall).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries conflicts once and surfaces the conflict when it persists', async () => {
    const conflict = Object.assign(new Error('conflict'), { code: 'conflict' });
    const guardedCall = vi.fn(async () => {
      throw conflict;
    });
    const sleepCalls: number[] = [];

    await expect(
      callWithGuard('gpconnect.create', guardedCall, {
        maxRetries: 1,
        baseDelayMs: 25,
        random: () => 0,
        now: createNowStepper(15),
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(conflict);

    expect(guardedCall).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([25]);
  });
});
