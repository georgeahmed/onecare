import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Topics, type TriageInput, type TypedEnvelope } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';
import { InMemoryIdempotencyStore } from '../src/application/idempotency';
import {
  server,
  setBusReadyForTest,
  getMessageBusForTest,
  setIdempotencyStoreForTest,
  resetIdempotencyStoreForTest,
} from '../src/index';

vi.mock('../src/adapters/services/safetyGate', async () => {
  const actual = await vi.importActual<typeof import('../src/adapters/services/safetyGate')>(
    '../src/adapters/services/safetyGate'
  );
  return {
    ...actual,
    analyzePortalSubmission: vi.fn().mockResolvedValue({ outcome: 'SAFE_TO_CONTINUE' }),
  };
});

let bus: MessageBus;
let base: string;

function baseUrl(): string {
  if (base) return base;
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server not listening');
  base = `http://127.0.0.1:${(addr as AddressInfo).port}`;
  return base;
}

async function subscribeTriage(handler: (envelope: TypedEnvelope<TriageInput>) => void): Promise<Subscription> {
  return bus.subscribe<TypedEnvelope<TriageInput>>(Topics.triage.input, (msg) => handler(msg.payload));
}

async function postSafetyCheck(payload: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl()}/safety-check`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

const submission = {
  practiceId: 'p1',
  patient: { id: 'patient-123' },
  narrative: 'sample narrative',
  channel: 'web' as const,
};

const authHeaders = {
  authorization: 'Bearer token',
  'content-type': 'application/json',
  'x-actor-type': 'patient',
  'x-actor-id': 'patient-123',
  'x-request-id': 'req-uniq-1',
  'x-auth-scope': 'submit',
};

describe('idempotency guard', () => {
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
    base = '';
    setBusReadyForTest(true);
    setIdempotencyStoreForTest(new InMemoryIdempotencyStore());
  });

  afterEach(() => {
    resetIdempotencyStoreForTest();
  });

  it('returns conflict on sequential duplicate submissions', async () => {
    const envelopes: TypedEnvelope<TriageInput>[] = [];
    const sub = await subscribeTriage((env) => envelopes.push(env));

    const first = await postSafetyCheck(submission, authHeaders);
    await sub.unsubscribe();

    expect(first.status).toBe(200);
    const key = first.headers.get('x-idempotency-key');
    expect(key).toBeTruthy();

    const conflict = await postSafetyCheck(submission, { ...authHeaders, 'x-request-id': 'req-uniq-2' });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('x-idempotency-key')).toBe(key);
    const body = await conflict.json();
    expect(body?.error?.code).toBe('conflict');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.payload.patientId).toBe(submission.patient.id);
  });

  it('allows only one request to proceed under concurrency', async () => {
    const events: TypedEnvelope<TriageInput>[] = [];
    const sub = await subscribeTriage((env) => events.push(env));
    const concurrencyHeaders = {
      ...authHeaders,
      'x-idempotency-key': 'concurrent-key',
    };

    const requests = Array.from({ length: 5 }, (_, idx) =>
      postSafetyCheck(submission, { ...concurrencyHeaders, 'x-request-id': `req-concurrent-${idx}` })
    );
    const results = await Promise.all(requests);
    await sub.unsubscribe();

    const successCount = results.filter((r) => r.status === 200).length;
    const conflictCount = results.filter((r) => r.status === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(4);

    const keys = results.map((r) => r.headers.get('x-idempotency-key'));
    expect(new Set(keys)).toEqual(new Set(['concurrent-key']));
    expect(events).toHaveLength(1);
  });
});
