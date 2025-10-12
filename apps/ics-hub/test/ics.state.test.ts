import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InboundState, ValidatedState, type IcsContext, type IcsEvent } from '../src/application/ics.state';
import type { IcsClient } from '../src/adapters/ics.client';
import { resetMetrics, getCounterRecords, logger } from '@onecare/observability';

const baseEvent: IcsEvent = { type: 'ics.route' };

function createClientStub(): IcsClient {
  return {
    sendReferral: vi.fn(),
    acknowledge: vi.fn(),
  };
}

function createContext(overrides: Partial<IcsContext>): IcsContext {
  return {
    client: createClientStub(),
    organisationId: 'org1',
    ...overrides,
  };
}

describe('InboundState', () => {
  beforeEach(() => {
    resetMetrics();
    vi.restoreAllMocks();
  });

  it('allows known organisation when within per-org limit', async () => {
    const state = new InboundState({
      ORG1: { endpoint: 'https://ics.example/org1', authRef: 'secrets/org1', rateLimit: 5 },
    });
    const ctx = createContext({ organisationId: 'ORG1', correlationId: 'corr-allowed' });

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Validated');
    expect(ctx.blocked).toBe(false);
    expect(ctx.rateLimited).toBe(false);
    expect(ctx.routePolicy?.endpoint).toBe('https://ics.example/org1');
    expect(ctx.organisationId).toBe('org1');
    expect(ctx.routingOutcome).toMatchObject({
      status: 'allowed',
      policy: {
        endpoint: 'https://ics.example/org1',
        authRef: 'secrets/org1',
        rateLimit: 5,
      },
    });
    const decisionRecords = getCounterRecords('ics.routing.decisions_total');
    expect(decisionRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ outcome: 'allowed', organisationId: 'org1' }),
        }),
      ]),
    );
  });

  it('flags unknown organisation as blocked', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const state = new InboundState({
      ORGX: { endpoint: 'https://ics.example/orgx', rateLimit: 2 },
    });
    const ctx = createContext({ organisationId: 'UNLISTED', correlationId: 'corr-blocked' });

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Validated');
    expect(ctx.blocked).toBe(true);
    expect(ctx.rateLimited).toBe(false);
    expect(ctx.routePolicy).toBeUndefined();
    expect(ctx.routingOutcome).toMatchObject({
      status: 'forbidden',
      httpStatus: 403,
      error: {
        error: {
          code: 'forbidden',
          message: 'organisation_not_allowed',
          correlationId: 'corr-blocked',
          details: { organisationId: 'unlisted' },
        },
      },
    });
    const blockedCall = warnSpy.mock.calls.find(([msg]) => msg === 'ics.routing.blocked');
    expect(blockedCall?.[1]).toMatchObject({
      organisationId: 'unlisted',
      correlationId: 'corr-blocked',
      result: 'blocked',
    });
    const blockedRecords = getCounterRecords('ics.routing.blocked_total');
    expect(blockedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ organisationId: 'unlisted' }),
        }),
      ]),
    );
  });

  it('marks organisation as rate limited when limit exceeded', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let now = 1_000;
    const state = new InboundState(
      {
        ORG1: { endpoint: 'https://ics.example/org1', rateLimit: 1 },
      },
      { now: () => now },
    );

    const first = createContext({ organisationId: 'org1', correlationId: 'corr-first' });
    await state.handle(first, baseEvent);
    expect(first.rateLimited).toBe(false);
    expect(first.routingOutcome).toMatchObject({
      status: 'allowed',
    });

    const second = createContext({ organisationId: 'org1', correlationId: 'corr-second' });
    now += 10; // remain within same window to trigger rate limit
    const next = await state.handle(second, baseEvent);

    expect(next).toBe('Validated');
    expect(second.blocked).toBe(false);
    expect(second.rateLimited).toBe(true);
    expect(second.routePolicy?.endpoint).toBe('https://ics.example/org1');
    expect(second.routingOutcome).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
      policy: { endpoint: 'https://ics.example/org1' },
      error: {
        error: {
          code: 'too_many_requests',
          message: 'rate_limit_exceeded',
          correlationId: 'corr-second',
          details: expect.objectContaining({
            organisationId: 'org1',
            limitPerMinute: 1,
          }),
        },
      },
      retryAfterMs: expect.any(Number),
    });
    expect(second.routingOutcome?.retryAfterMs).toBeGreaterThan(0);
    const rateLimitCall = warnSpy.mock.calls.find(([msg]) => msg === 'ics.routing.rate_limited');
    expect(rateLimitCall?.[1]).toMatchObject({
      organisationId: 'org1',
      correlationId: 'corr-second',
      result: 'rate_limited',
    });
    const rateRecords = getCounterRecords('ics.routing.rate_limited_total');
    expect(rateRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ organisationId: 'org1' }),
        }),
      ]),
    );
  });
});

describe('ValidatedState', () => {
  it('transitions to blocked or rate limited based on context flags', async () => {
    const state = new ValidatedState();
    const blockedCtx = createContext({ blocked: true });
    const blocked = await state.handle(
      blockedCtx,
      baseEvent,
    );
    expect(blocked).toBe('Blocked');
    expect(blockedCtx.routingOutcome).toMatchObject({
      status: 'forbidden',
      httpStatus: 403,
    });

    const limitedCtx = createContext({ rateLimited: true, routePolicy: { endpoint: 'https://ics.example/org1' } });
    const limited = await state.handle(
      limitedCtx,
      baseEvent,
    );
    expect(limited).toBe('RateLimited');
    expect(limitedCtx.routingOutcome).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
    });
  });

  it('requires route policy before routing', async () => {
    const state = new ValidatedState();
    const ctx = createContext({
      blocked: false,
      rateLimited: false,
      routePolicy: { endpoint: 'https://ics.example/org1' },
    });
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('Routed');

    const missingPolicy = createContext({ blocked: false, rateLimited: false });
    await expect(state.handle(missingPolicy, baseEvent)).rejects.toThrow('route_policy_missing');
  });
});
