import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { Topics, type TriageInput, type PortalSubmission } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';

vi.mock('../src/adapters/services/callWithGuard', async () => {
  const fallbackError = Object.assign(new Error('circuit_open'), { code: 'circuit_open' });
  return {
    callWithGuard: vi.fn().mockRejectedValue(fallbackError),
    resetGuardBreakers: vi.fn(),
  };
});

import { server, setBusReadyForTest, getMessageBusForTest, setIdempotencyStoreForTest, resetIdempotencyStoreForTest } from '../src/index';
import { InMemoryIdempotencyStore, deriveIdempotencyKey } from '../src/application/idempotency';
import { resetSecurityServices } from '../src/adapters/security';

let bus: MessageBus;
let baseUrl: string;
const SHARED_SECRET = 'test-shared-secret';

function url(): string {
  if (baseUrl) return baseUrl;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server not listening');
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return baseUrl;
}

async function subscribeTriage(handler: (payload: TriageInput) => void): Promise<Subscription> {
  return bus.subscribe(Topics.triage.input, (msg) => handler(msg.payload as TriageInput));
}

describe('safety gate fallback', () => {
  beforeAll(async () => {
    delete process.env.NATS_URL;
    process.env.BUS_IMPL = 'memory';
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    bus = getMessageBusForTest();
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.SECURITY_SHARED_SECRET;
  });

  beforeEach(() => {
    baseUrl = '';
    setBusReadyForTest(true);
    setIdempotencyStoreForTest(new InMemoryIdempotencyStore());
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    resetSecurityServices();
  });

  afterEach(() => {
    resetIdempotencyStoreForTest();
  });

  it('falls back to rules when circuit is open', async () => {
    const events: TriageInput[] = [];
    const sub = await subscribeTriage((payload) => events.push(payload));

    const requestId = 'fallback-test';
    const payload: PortalSubmission = {
      practiceId: 'practice-1',
      patient: { id: 'patient-1' },
      narrative: 'fallback scenario',
      channel: 'web',
    };
    const idemKey = deriveIdempotencyKey(payload, payload.patient.id);
    const fingerprint = `${requestId}:${idemKey}`;
    const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
    const res = await fetch(`${url()}/safety-check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signature}`,
        'x-actor-type': 'patient',
        'x-actor-id': 'patient-1',
        'x-request-id': requestId,
        'x-auth-scope': 'submit',
      },
      body: JSON.stringify(payload),
    });

    await sub.unsubscribe();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.outcome).toBe('SAFE_TO_CONTINUE');
    expect(body?.reason).toBe('FALLBACK_RULES');
    expect(events).toHaveLength(1);
  });
});
