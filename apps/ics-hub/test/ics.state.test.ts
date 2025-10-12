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
    const state = new InboundState({
      ORG1: { endpoint: 'https://ics.example/org1', rateLimit: 1 },
    });

    const first = createContext({ organisationId: 'org1', correlationId: 'corr-first' });
    await state.handle(first, baseEvent);
    expect(first.rateLimited).toBe(false);

    const second = createContext({ organisationId: 'org1', correlationId: 'corr-second' });
    const next = await state.handle(second, baseEvent);

    expect(next).toBe('Validated');
    expect(second.blocked).toBe(false);
    expect(second.rateLimited).toBe(true);
    expect(second.routePolicy?.endpoint).toBe('https://ics.example/org1');
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
    const blocked = await state.handle(
      createContext({ blocked: true }),
      baseEvent,
    );
    expect(blocked).toBe('Blocked');

    const limited = await state.handle(
      createContext({ rateLimited: true }),
      baseEvent,
    );
    expect(limited).toBe('RateLimited');
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
