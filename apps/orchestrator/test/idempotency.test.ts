import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { Topics, type TriageInput, type TypedEnvelope } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';
import { InMemoryIdempotencyStore, deriveIdempotencyKey } from '../src/application/idempotency';
import {
  server,
  setBusReadyForTest,
  getMessageBusForTest,
  setIdempotencyStoreForTest,
  resetIdempotencyStoreForTest,
} from '../src/index';
import { resetSecurityServices } from '../src/adapters/security';
import * as callGuard from '../src/adapters/services/callWithGuard';

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

const SHARED_SECRET = 'test-shared-secret';

const submission = {
  practiceId: 'p1',
  patient: { id: 'patient-123' },
  narrative: 'sample narrative',
  channel: 'web' as const,
};

function buildAuthHeaders(
  requestId: string,
  payload: typeof submission,
  overrides: Record<string, string> = {}
): Record<string, string> {
  const actorId = overrides['x-actor-id'] ?? payload.patient.id;
  const explicitKey = overrides['x-idempotency-key'];
  const derivedKey = explicitKey ?? deriveIdempotencyKey(payload, actorId);
  const fingerprint = `${requestId}:${derivedKey}`;
  const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
  return {
    authorization: `Bearer ${signature}`,
    'content-type': 'application/json',
    'x-actor-type': 'patient',
    'x-actor-id': actorId,
    'x-request-id': requestId,
    'x-auth-scope': 'submit',
    ...overrides,
  };
}

describe('deriveIdempotencyKey', () => {
  it('changes when attachment metadata differs', () => {
    const baseSubmission = {
      practiceId: 'p1',
      patient: { id: 'patient-1' },
      narrative: 'same length narrative',
      channel: 'web' as const,
      attachments: [
        { contentType: 'application/pdf', url: 'https://files.example/1' },
        { contentType: 'image/png', url: 'https://files.example/2' },
      ],
    };
    const mutated = {
      ...baseSubmission,
      attachments: [
        { contentType: 'application/pdf', url: 'https://files.example/1' },
        { contentType: 'image/png', url: 'https://files.example/3' },
      ],
    };
    const actor = 'patient-1';
    const first = deriveIdempotencyKey(baseSubmission, actor);
    const second = deriveIdempotencyKey(mutated, actor);
    expect(first).not.toBe(second);
  });
});

describe('idempotency guard', () => {
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
    delete process.env.SECURITY_SHARED_SECRET;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    base = '';
    setBusReadyForTest(true);
    setIdempotencyStoreForTest(new InMemoryIdempotencyStore());
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    resetSecurityServices();
  });

  afterEach(() => {
    resetIdempotencyStoreForTest();
  });

  it('returns conflict on sequential duplicate submissions', async () => {
    const envelopes: TypedEnvelope<TriageInput>[] = [];
    const sub = await subscribeTriage((env) => envelopes.push(env));

    const first = await postSafetyCheck(submission, buildAuthHeaders('req-uniq-1', submission));

    expect(first.status).toBe(200);
    const key = first.headers.get('x-idempotency-key');
    expect(key).toBeTruthy();

    const conflict = await postSafetyCheck(submission, buildAuthHeaders('req-uniq-2', submission));
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('x-idempotency-key')).toBe(key);
    const body = await conflict.json();
    expect(body?.error?.code).toBe('conflict');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.payload.patientId).toBe(submission.patient.id);

    await sub.unsubscribe();
  });

  it('derives different keys for narratives with equal length but different content', async () => {
    const envelopes: TypedEnvelope<TriageInput>[] = [];
    const sub = await subscribeTriage((env) => envelopes.push(env));

    const firstSubmission = { ...submission, narrative: '111122223333' };
    const secondSubmission = { ...submission, narrative: 'aaaabbbbcccc' };

    const first = await postSafetyCheck(firstSubmission, buildAuthHeaders('req-uniq-1', firstSubmission));
    expect(first.status).toBe(200);
    const firstKey = first.headers.get('x-idempotency-key');
    expect(firstKey).toBeTruthy();

    const second = await postSafetyCheck(secondSubmission, buildAuthHeaders('req-uniq-3', secondSubmission));
    expect(second.status).toBe(200);
    const secondKey = second.headers.get('x-idempotency-key');
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);

    await sub.unsubscribe();
    expect(envelopes).toHaveLength(2);
  });

  it('allows only one request to proceed under concurrency', async () => {
    const events: TypedEnvelope<TriageInput>[] = [];
    const sub = await subscribeTriage((env) => events.push(env));
    const requests = Array.from({ length: 5 }, (_, idx) => {
      const requestId = `req-concurrent-${idx}`;
      const headers = buildAuthHeaders(requestId, submission, { 'x-idempotency-key': 'concurrent-key' });
      return postSafetyCheck(submission, headers);
    });
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

  it('releases reservations after guarded upstream failures', async () => {
    const events: TypedEnvelope<TriageInput>[] = [];
    const sub = await subscribeTriage((env) => events.push(env));
    const original = callGuard.callWithGuard;
    const timeoutError = Object.assign(new Error('gateway timeout'), { code: 'upstream_timeout' });
    const guardSpy = vi
      .spyOn(callGuard, 'callWithGuard')
      .mockImplementationOnce(async () => {
        throw timeoutError;
      })
      .mockImplementation((name, fn, opts) => original(name, fn, opts));

    const first = await postSafetyCheck(submission, buildAuthHeaders('req-timeout-1', submission));
    expect(first.status).toBe(504);
    const firstKey = first.headers.get('x-idempotency-key');
    expect(firstKey).toBeTruthy();

    const retryHeaders = buildAuthHeaders('req-timeout-2', submission);
    const retry = await postSafetyCheck(submission, retryHeaders);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('x-idempotency-key')).toBe(firstKey);

    await sub.unsubscribe();
    guardSpy.mockRestore();
    expect(events).toHaveLength(1);
  });
});
