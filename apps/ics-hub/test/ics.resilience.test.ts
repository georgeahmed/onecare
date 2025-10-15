import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RoutedState, type IcsContext, type IcsEvent } from '../src/application/ics.state';
import type { IcsClient } from '../src/adapters/ics.client';
import type { MessageBus } from '@onecare/bus';
import type { IdempotencyStore } from '@onecare/ports';
import { Topics, createEnvelope, type TypedEnvelope, type IcsReferralRequest } from '@onecare/events';
import { resetMetrics, getCounterRecords } from '@onecare/observability';

const baseEvent: IcsEvent = { type: 'ics.route' };

class RecordingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

function createClientStub(): IcsClient {
  return {
    sendReferral: vi.fn(),
    acknowledge: vi.fn(),
  };
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, number>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string, ttlSeconds: number) => {
      keys.set(key, ttlSeconds);
    },
    reserve: async (key: string, ttlSeconds: number) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, ttlSeconds);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

function buildEnvelope(overrides: Partial<IcsReferralRequest> = {}, envelopeOverrides: Partial<TypedEnvelope<IcsReferralRequest>> = {}): TypedEnvelope<IcsReferralRequest> {
  return {
    id: envelopeOverrides.id ?? 'env-resilience',
    topic: envelopeOverrides.topic ?? Topics.ics.referralRequest,
    timestamp: envelopeOverrides.timestamp ?? '2025-01-01T00:00:00.000Z',
    correlationId: envelopeOverrides.correlationId ?? 'corr-resilience',
    payload: {
      referralId: overrides.referralId ?? 'ref-resilience',
      patientId: overrides.patientId ?? 'patient-123',
      org: overrides.org ?? 'ORG1',
      reason: overrides.reason ?? 'support',
    },
  };
}

function createContext(overrides: Partial<IcsContext>, envelope: TypedEnvelope<IcsReferralRequest>): IcsContext {
  return {
    id: overrides.id ?? 'ctx-resilience',
    client: overrides.client ?? createClientStub(),
    bus: overrides.bus,
    idempotencyStore: overrides.idempotencyStore,
    referralEnvelope: envelope,
    referral: envelope.payload,
    routeDecision: overrides.routeDecision ?? { destinationOrgId: 'dest-1', policy: 'fallback', rationale: 'route' },
    routePolicy: overrides.routePolicy ?? { endpoint: 'https://ics.example/dest-1', rateLimit: 5 },
    routingOutcome: overrides.routingOutcome ?? {
      status: 'allowed',
      policy: { endpoint: 'https://ics.example/dest-1', rateLimit: 5 },
      routeDecision: { destinationOrgId: 'dest-1', policy: 'fallback', rationale: 'route' },
    },
    correlationId: envelope.correlationId,
    auditIntents: overrides.auditIntents ?? [],
    receivedAtMs: overrides.receivedAtMs ?? Date.now(),
    ...overrides,
  } as IcsContext;
}

describe('ICS routed state resilience', () => {
  beforeEach(() => {
    resetMetrics();
    vi.restoreAllMocks();
  });

  it('retries after upstream failure with cleared idempotency key', async () => {
    const envelope = buildEnvelope();
    const client = createClientStub();
    const sendReferral = vi
      .fn<Parameters<IcsClient['sendReferral']>, ReturnType<IcsClient['sendReferral']>>()
      .mockRejectedValueOnce(new Error('upstream_unavailable'))
      .mockResolvedValue({ referralId: envelope.payload.referralId, accepted: true });
    client.sendReferral = sendReferral;
    const bus = new RecordingBus();
    const store = createIdempotencyStore();
    const state = new RoutedState();
    const failingContext = createContext({ client, bus, idempotencyStore: store }, envelope);

    await expect(state.handle(failingContext, baseEvent)).rejects.toThrow('upstream_unavailable');
    const failureRecords = getCounterRecords('ics.ack.failed_total');
    expect(failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ destinationOrgId: 'dest-1' }) }),
      ]),
    );

    const recoveryBus = new RecordingBus();
    const recoveryContext = createContext({ client, bus: recoveryBus, idempotencyStore: store }, envelope);
    await expect(state.handle(recoveryContext, baseEvent)).resolves.toBe('Acked');
    expect(sendReferral).toHaveBeenCalledTimes(2);
    expect(recoveryBus.publishes).toHaveLength(1);
    const ackRecords = getCounterRecords('ics.ack.published_total');
    expect(ackRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ destinationOrgId: 'dest-1' }) }),
      ]),
    );
  });
});
