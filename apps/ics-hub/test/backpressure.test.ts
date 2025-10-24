import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessingLimiter } from '../src/application/backpressure';
import { InboundState } from '../src/application/ics.state';
import type { IcsContext, IcsEvent } from '../src/application/ics.state';
import type { IcsClient } from '../src/adapters/ics.client';
import type { TypedEnvelope, IcsReferralRequest } from '@onecare/events';
import { Topics } from '@onecare/events';

const baseEvent: IcsEvent = { type: 'ics.route' };

function createLimiter(options?: Partial<Parameters<typeof ProcessingLimiter>[0]>) {
  return new ProcessingLimiter({ maxConcurrency: 1, ...options });
}

function createEnvelope(): TypedEnvelope<IcsReferralRequest> {
  return {
    id: 'env-1',
    topic: Topics.ics.referralRequest,
    timestamp: '2025-01-01T00:00:00.000Z',
    correlationId: 'corr-1',
    payload: {
      referralId: 'ref-1',
      patientId: 'patient-1',
      org: 'ORG1',
      reason: 'support',
    },
  };
}

function createContext(overrides: Partial<IcsContext> = {}): IcsContext {
  const envelope = overrides.referralEnvelope ?? createEnvelope();
  const client: IcsClient = overrides.client ?? {
    sendReferral: async () => ({ referralId: 'ref-1', accepted: true }),
    acknowledge: async () => ({ referralId: 'ref-1', accepted: true }),
  };
  return {
    id: overrides.id ?? 'ctx-1',
    client,
    rawEnvelope: envelope,
    referralEnvelope: envelope,
    auditIntents: [],
    ...overrides,
  } as IcsContext;
}

describe('ProcessingLimiter', () => {
  it('allows release to unblock queued waiters', async () => {
    const limiter = createLimiter({ maxConcurrency: 1 });
    const releaseFirst = await limiter.acquire('first');
    const acquireSecond = limiter.acquire('second');
    releaseFirst();
    const releaseSecond = await acquireSecond;
    releaseSecond();
    await limiter.waitForIdle();
    expect(limiter.inflightCount).toBe(0);
  });

  it('throws when queue limit exceeded', async () => {
    const limiter = createLimiter({ maxConcurrency: 1, queueLimit: 1 });
    const release = await limiter.acquire('first');
    void limiter.acquire('second');
    await expect(limiter.acquire('overflow')).rejects.toThrow('processing_queue_overflow');
    release();
  });

  it('flags overload when queue reaches high watermark', async () => {
    const limiter = createLimiter({ maxConcurrency: 1, highWatermark: 1, queueLimit: 2 });
    const release = await limiter.acquire('first');
    void limiter.acquire('second');
    expect(limiter.isOverloaded()).toBe(true);
    release();
  });
});

describe('InboundState with backpressure', () => {
  let state: InboundState;

  beforeEach(() => {
    state = new InboundState({
      ORG1: { endpoint: 'https://ics.example/org1', rateLimit: 10 },
    });
  });

  it('returns rate-limited outcome when processing limiter overloaded', async () => {
    const limiter = createLimiter({ maxConcurrency: 1, highWatermark: 1, queueLimit: 2, retryAfterSeconds: 2 });
    const release = await limiter.acquire('first');
    void limiter.acquire('second');

    const ctx = createContext({ processingLimiter: limiter });
    const envelope = createEnvelope();
    ctx.rawEnvelope = envelope;
    ctx.referralEnvelope = envelope;

    const outcome = await state.handle(ctx, baseEvent);
    expect(outcome).toBe('Validated');
    expect(ctx.routingOutcome?.status).toBe('rate_limited');
    expect(ctx.retryAfterSeconds).toBe(2);
    expect(ctx.responseHeaders?.['Retry-After']).toBe('2');
    release();
  });
});
