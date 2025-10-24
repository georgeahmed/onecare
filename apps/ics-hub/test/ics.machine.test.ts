import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildIcsMachine, runIcsMachine } from '../src/application/ics.machine';
import {
  initialiseIcsContext,
  type IcsContext,
  type IcsEvent,
} from '../src/application/ics.state';
import type { MessageBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, type IcsReferralRequest } from '@onecare/events';
import type { IcsClient } from '../src/adapters/ics.client';
import type { IdempotencyStore } from '@onecare/ports';
import { ProcessingLimiter } from '../src/application/backpressure';
import { AuditSpool } from '../src/application/audit.spool';
import { resetMetrics } from '@onecare/observability';

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

function buildEnvelope(overrides: Partial<IcsReferralRequest> = {}): TypedEnvelope<IcsReferralRequest> {
  return {
    id: 'env-machine',
    topic: Topics.ics.referralRequest,
    timestamp: '2025-01-01T00:00:00.000Z',
    correlationId: 'corr-machine',
    payload: {
      referralId: overrides.referralId ?? 'ref-machine',
      patientId: overrides.patientId ?? 'patient-machine',
      org: overrides.org ?? 'ORG1',
      reason: overrides.reason ?? 'support',
    },
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
      if (keys.has(key)) return 'exists';
      keys.set(key, { ttl: ttlSeconds, storedAt: Date.now() });
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

function createClientStub(): IcsClient {
  return {
    sendReferral: vi.fn(),
    acknowledge: vi.fn(),
  };
}

describe('ICS machine integration', () => {
  beforeEach(() => {
    resetMetrics();
    vi.useRealTimers();
  });

  it('routes an allowed referral through to acknowledgment', async () => {
    const envelope = buildEnvelope();
    const bus = new RecordingBus();
    const client = createClientStub();
    const ackPayload = { referralId: envelope.payload.referralId, accepted: true };
    client.sendReferral = vi.fn(async () => ackPayload);
    const store = createIdempotencyStore();
    const limiter = new ProcessingLimiter({ maxConcurrency: 2 });
    const ctx: IcsContext = initialiseIcsContext(
      {
        id: 'ctx-machine-allow',
        client,
        bus,
        idempotencyStore: store,
        auditIntents: [],
        rawEnvelope: envelope,
        referralEnvelope: envelope,
      },
      {
        auditSpool: new AuditSpool(() => bus, { publishOptions: { timeoutMs: 0, maxRetries: 0 } }),
        processingLimiter: limiter,
      },
    );

    const machine = buildIcsMachine(ctx, {
      policies: {
        ORG1: { endpoint: 'https://ics.example/org1', rateLimit: 10 },
      },
    });

    await runIcsMachine(machine, { event: baseEvent });

    expect(machine.state).toBe('Acked');
    expect(client.sendReferral).toHaveBeenCalledTimes(1);
    const ackPublish = bus.publishes.find((entry) => entry.topic === Topics.ics.referralAck);
    expect(ackPublish).toBeTruthy();
    expect(ctx.ack?.accepted).toBe(true);
  });

  it('stops in Blocked when organisation policy missing', async () => {
    const envelope = buildEnvelope({ org: 'UNKNOWN' });
    const bus = new RecordingBus();
    const client = createClientStub();
    client.sendReferral = vi.fn();
    const store = createIdempotencyStore();
    const ctx: IcsContext = initialiseIcsContext(
      {
        id: 'ctx-machine-blocked',
        client,
        bus,
        auditIntents: [],
        rawEnvelope: envelope,
        referralEnvelope: envelope,
        idempotencyStore: store,
      },
      { auditSpool: new AuditSpool(() => bus, { publishOptions: { timeoutMs: 0, maxRetries: 0 } }) },
    );

    const machine = buildIcsMachine(ctx, { policies: {} });

    await runIcsMachine(machine, { event: baseEvent });

    expect(machine.state).toBe('Blocked');
    expect(client.sendReferral).not.toHaveBeenCalled();
  });
});
