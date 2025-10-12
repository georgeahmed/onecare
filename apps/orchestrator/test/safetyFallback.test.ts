import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Topics, type TriageInput } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';

vi.mock('../src/adapters/services/callWithGuard', async () => {
  const fallbackError = Object.assign(new Error('circuit_open'), { code: 'circuit_open' });
  return {
    callWithGuard: vi.fn().mockRejectedValue(fallbackError),
    resetGuardBreakers: vi.fn(),
  };
});

import { server, setBusReadyForTest, getMessageBusForTest, setIdempotencyStoreForTest, resetIdempotencyStoreForTest } from '../src/index';
import { InMemoryIdempotencyStore } from '../src/application/idempotency';

let bus: MessageBus;
let baseUrl: string;

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
    bus = getMessageBusForTest();
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    baseUrl = '';
    setBusReadyForTest(true);
    setIdempotencyStoreForTest(new InMemoryIdempotencyStore());
  });

  afterEach(() => {
    resetIdempotencyStoreForTest();
  });

  it('falls back to rules when circuit is open', async () => {
    const events: TriageInput[] = [];
    const sub = await subscribeTriage((payload) => events.push(payload));

    const res = await fetch(`${url()}/safety-check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token',
        'x-actor-type': 'patient',
        'x-actor-id': 'patient-1',
        'x-request-id': 'fallback-test',
        'x-auth-scope': 'submit',
      },
      body: JSON.stringify({
        practiceId: 'practice-1',
        patient: { id: 'patient-1' },
        narrative: 'fallback scenario',
        channel: 'web',
      }),
    });

    await sub.unsubscribe();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.outcome).toBe('SAFE_TO_CONTINUE');
    expect(body?.reason).toBe('FALLBACK_RULES');
    expect(events).toHaveLength(1);
  });
});
