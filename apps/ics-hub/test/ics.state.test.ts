import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InboundState,
  ValidatedState,
  InvalidState,
  RoutedState,
  type IcsContext,
  type IcsEvent,
  type RoutingOutcome,
} from '../src/application/ics.state';
import type { IcsClient } from '../src/adapters/ics.client';
import { resetMetrics, getCounterRecords, logger } from '@onecare/observability';
import { Topics, type TypedEnvelope, type IcsReferralRequest } from '@onecare/events';
import type { IdempotencyStore } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';

const baseEvent: IcsEvent = { type: 'ics.route' };

function createClientStub(): IcsClient {
  return {
    sendReferral: vi.fn(),
    acknowledge: vi.fn(),
  };
}

function buildEnvelope(
  payloadOverrides: Partial<IcsReferralRequest> = {},
  envelopeOverrides: Partial<TypedEnvelope<IcsReferralRequest>> = {},
): TypedEnvelope<IcsReferralRequest> {
  return {
    id: envelopeOverrides.id ?? 'env-1',
    topic: envelopeOverrides.topic ?? Topics.ics.referralRequest,
    timestamp: envelopeOverrides.timestamp ?? '2025-01-01T00:00:00.000Z',
    correlationId: envelopeOverrides.correlationId ?? 'corr-1',
    payload: {
      referralId: payloadOverrides.referralId ?? 'ref-1',
      patientId: payloadOverrides.patientId ?? 'patient-1',
      org: payloadOverrides.org ?? 'ORG1',
      reason: payloadOverrides.reason ?? 'routine',
    },
  };
}

function createContext(overrides: Partial<IcsContext> = {}, envelope?: TypedEnvelope<IcsReferralRequest>): IcsContext {
  return {
    id: overrides.id ?? 'ctx-1',
    client: overrides.client ?? createClientStub(),
    rawEnvelope: envelope ?? overrides.rawEnvelope ?? buildEnvelope(),
    auditIntents: overrides.auditIntents ?? [],
    bus: overrides.bus,
    idempotencyStore: overrides.idempotencyStore,
    referralEnvelope: overrides.referralEnvelope ?? envelope,
    referral: overrides.referral,
    routePolicy: overrides.routePolicy,
    routeDecision: overrides.routeDecision,
    routingOutcome: overrides.routingOutcome,
    correlationId: overrides.correlationId,
    automationConfig: overrides.automationConfig,
    automationTasks: overrides.automationTasks,
    automationEvent: overrides.automationEvent,
    automationIntents: overrides.automationIntents,
    automationPublished: overrides.automationPublished,
    idempotencyTtlSeconds: overrides.idempotencyTtlSeconds,
    automationPublishIdempotencyKey: overrides.automationPublishIdempotencyKey,
    ackPublishIdempotencyKey: overrides.ackPublishIdempotencyKey,
    ackPublishOptions: overrides.ackPublishOptions,
    receivedAtMs: overrides.receivedAtMs,
    responseHeaders: overrides.responseHeaders,
    retryAfterSeconds: overrides.retryAfterSeconds,
    ...overrides,
  };
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, { ttl: number; storedAt: number }>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string, ttlSeconds: number) => {
      keys.set(key, { ttl: ttlSeconds, storedAt: Date.now() });
    },
    reserve: async (key: string, ttlSeconds: number) => {
      if (keys.has(key)) return 'exists' as const;
      keys.set(key, { ttl: ttlSeconds, storedAt: Date.now() });
      return 'reserved' as const;
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

class RecordingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

describe('InboundState', () => {
  beforeEach(() => {
    resetMetrics();
    vi.restoreAllMocks();
  });

  it('allows known organisation and records audit intents', async () => {
    const envelope = buildEnvelope({ org: 'ORG1', referralId: 'ref-allow' }, { correlationId: 'corr-allowed' });
    const state = new InboundState({
      ORG1: { endpoint: 'https://ics.example/org1', authRef: 'secrets/org1', rateLimit: 5 },
    });
    const ctx = createContext({ rawEnvelope: envelope }, envelope);

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Validated');
    expect(ctx.blocked).toBe(false);
    expect(ctx.rateLimited).toBe(false);
    expect(ctx.invalid).toBeUndefined();
    expect(ctx.routePolicy?.endpoint).toBe('https://ics.example/org1');
    expect(ctx.organisationId).toBe('org1');
    expect(ctx.routeDecision).toMatchObject({
      destinationOrgId: 'ORG1',
      policy: 'fallback',
    });
    expect(ctx.routingOutcome).toMatchObject({
      status: 'allowed',
      policy: expect.objectContaining({ endpoint: 'https://ics.example/org1' }),
      routeDecision: expect.objectContaining({ destinationOrgId: 'ORG1' }),
    });
    expect(ctx.auditIntents).toHaveLength(2);
    expect(ctx.auditIntents?.[0]).toMatchObject({
      type: 'ics.referral.received',
      correlationId: 'corr-allowed',
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
    const envelope = buildEnvelope({ org: 'UNLISTED', referralId: 'ref-blocked' }, { correlationId: 'corr-blocked' });
    const state = new InboundState({
      ORGX: { endpoint: 'https://ics.example/orgx', rateLimit: 2 },
    });
    const ctx = createContext({ rawEnvelope: envelope }, envelope);

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Validated');
    expect(ctx.blocked).toBe(true);
    expect(ctx.rateLimited).toBe(false);
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
      {},
      { now: () => now },
    );

    const firstEnvelope = buildEnvelope({ org: 'ORG1', referralId: 'ref-first' }, { correlationId: 'corr-first' });
    const first = createContext({ rawEnvelope: firstEnvelope }, firstEnvelope);
    await state.handle(first, baseEvent);
    expect(first.rateLimited).toBe(false);
    expect(first.routingOutcome).toMatchObject({ status: 'allowed' });

    const secondEnvelope = buildEnvelope({ org: 'ORG1', referralId: 'ref-second' }, { correlationId: 'corr-second' });
    const second = createContext({ rawEnvelope: secondEnvelope }, secondEnvelope);
    now += 10; // remain within same window to trigger rate limit
    const next = await state.handle(second, baseEvent);

    expect(next).toBe('Validated');
    expect(second.blocked).toBe(false);
    expect(second.rateLimited).toBe(true);
    expect(second.routePolicy?.endpoint).toBe('https://ics.example/org1');
    expect(second.routingOutcome).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
      policy: expect.objectContaining({ endpoint: 'https://ics.example/org1' }),
      error: {
        error: expect.objectContaining({
          code: 'too_many_requests',
          message: 'rate_limit_exceeded',
          correlationId: 'corr-second',
        }),
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

  it('produces invalid outcome when payload fails validation', async () => {
    const state = new InboundState({
      ORG1: { endpoint: 'https://ics.example/org1', rateLimit: 5 },
    });
    const envelope = buildEnvelope({}, { correlationId: 'corr-invalid' });
    // @ts-expect-error - crafting invalid payload for test
    delete envelope.payload.org;
    const ctx = createContext({ rawEnvelope: envelope }, envelope);

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Validated');
    expect(ctx.invalid).toBe(true);
    expect(ctx.blocked).toBe(false);
    expect(ctx.rateLimited).toBe(false);
    expect(ctx.routingOutcome).toMatchObject({
      status: 'invalid',
      httpStatus: 400,
      error: {
        error: expect.objectContaining({
          code: 'invalid_input',
        }),
      },
    });
    expect(ctx.auditIntents).toHaveLength(1);
    expect(ctx.auditIntents?.[0]).toMatchObject({
      type: 'ics.referral.validation_failed',
    });
    const decisionRecords = getCounterRecords('ics.routing.decisions_total');
    expect(decisionRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ outcome: 'invalid' }),
        }),
      ]),
    );
  });
});

describe('ValidatedState', () => {
  it('transitions to blocked or rate limited based on context flags', async () => {
    const state = new ValidatedState();
    const blockedOutcome: RoutingOutcome = {
      status: 'forbidden',
      httpStatus: 403,
      error: { error: { code: 'forbidden', message: 'organisation_not_allowed' } },
    };
    const blockedCtx = createContext({ blocked: true, routingOutcome: blockedOutcome });
    const blocked = await state.handle(blockedCtx, baseEvent);
    expect(blocked).toBe('Blocked');
    expect(blockedCtx.routingOutcome).toMatchObject({
      status: 'forbidden',
      httpStatus: 403,
    });

    const limitedCtx = createContext({
      rateLimited: true,
      routePolicy: { endpoint: 'https://ics.example/org1' },
      routeDecision: { destinationOrgId: 'ORG1', policy: 'fallback', rationale: 'test' },
    });
    const limited = await state.handle(limitedCtx, baseEvent);
    expect(limited).toBe('RateLimited');
    expect(limitedCtx.routingOutcome).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
    });
  });

  it('yields Invalid when routing outcome marked invalid', async () => {
    const state = new ValidatedState();
    const ctx = createContext({
      routingOutcome: {
        status: 'invalid',
        httpStatus: 400,
        error: { error: { code: 'invalid_input', message: 'invalid' } },
      },
    });
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('Invalid');
  });

  it('requires route policy before routing', async () => {
    const state = new ValidatedState();
    const ctx = createContext({
      blocked: false,
      rateLimited: false,
      routePolicy: { endpoint: 'https://ics.example/org1' },
      routeDecision: { destinationOrgId: 'ORG1', policy: 'fallback', rationale: 'test' },
    });
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('Routed');

    const missingPolicy = createContext({ blocked: false, rateLimited: false });
    await expect(state.handle(missingPolicy, baseEvent)).rejects.toThrow('route_policy_missing');
  });
});

describe('RoutedState', () => {
  it('sends referral and publishes ack once', async () => {
    const envelope = buildEnvelope({ referralId: 'ref-send' }, { id: 'env-send', correlationId: 'corr-ack' });
    const client = createClientStub();
    const sendReferral = vi.fn(async () => ({ referralId: 'ref-send', accepted: true }));
    client.sendReferral = sendReferral;
    const bus = new RecordingBus();
    const store = createIdempotencyStore();
    const routeDecision = { destinationOrgId: 'dest-1', policy: 'fallback', rationale: 'test' as const };
    const ctx = createContext(
      {
        client,
        bus,
        idempotencyStore: store,
        referral: envelope.payload,
        referralEnvelope: envelope,
        routeDecision,
        routePolicy: { endpoint: 'https://ics.example/dest-1', rateLimit: 5, authRef: 'auth', tlsRef: 'tls' },
        routingOutcome: { status: 'allowed', policy: { endpoint: 'https://ics.example/dest-1', rateLimit: 5 }, routeDecision },
        correlationId: 'corr-ack',
        receivedAtMs: 10,
      },
      envelope,
    );
    const state = new RoutedState();

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Acked');
    expect(sendReferral).toHaveBeenCalledTimes(1);
    expect(bus.publishes).toHaveLength(1);
    const ackPublish = bus.publishes[0];
    expect(ackPublish.topic).toBe(Topics.ics.referralAck);
    expect(ctx.ack?.referralId).toBe('ref-send');
    expect(ctx.ackPublished).toBe(true);
    expect(ctx.ackLatencyMs).toBeGreaterThanOrEqual(0);
    expect(ackPublish.headers?.['x-correlation-id']).toBe('corr-ack');

    const duplicateBus = new RecordingBus();
    const duplicateCtx = createContext(
      {
        client,
        bus: duplicateBus,
        idempotencyStore: store,
        referral: envelope.payload,
        referralEnvelope: envelope,
        routeDecision,
        correlationId: 'corr-ack',
      },
      envelope,
    );
    sendReferral.mockClear();
    await state.handle(duplicateCtx, baseEvent);
    expect(sendReferral).not.toHaveBeenCalled();
    expect(duplicateBus.publishes).toHaveLength(0);
  });
});

describe('InvalidState', () => {
  it('self-transitions and preserves invalid outcome', async () => {
    const state = new InvalidState();
    const ctx = createContext({
      invalid: true,
      routingOutcome: {
        status: 'invalid',
        httpStatus: 400,
        error: { error: { code: 'invalid_input', message: 'invalid' } },
      },
    });
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('Invalid');
  });
});
