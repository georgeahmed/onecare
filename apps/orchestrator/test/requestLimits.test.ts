import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { PortalSubmission } from '@onecare/events';
import { InMemoryIdempotencyStore, deriveIdempotencyKey } from '../src/application/idempotency';
import {
  server,
  setBusReadyForTest,
  getMessageBusForTest,
  setIdempotencyStoreForTest,
  resetIdempotencyStoreForTest,
} from '../src/index';
import { resetSecurityServices } from '../src/adapters/security';

vi.mock('../src/adapters/services/safetyGate', async () => {
  const actual = await vi.importActual<typeof import('../src/adapters/services/safetyGate')>(
    '../src/adapters/services/safetyGate'
  );
  return {
    ...actual,
    analyzePortalSubmission: vi.fn().mockResolvedValue({ outcome: 'SAFE_TO_CONTINUE' }),
  };
});

const envBackup = process.env.MAX_BODY_BYTES;
const busImplBackup = process.env.BUS_IMPL;
const natsUrlBackup = process.env.NATS_URL;
const secretBackup = process.env.SECURITY_SHARED_SECRET;
let baseUrl: string;
const SHARED_SECRET = 'test-shared-secret';

function url(): string {
  if (baseUrl) return baseUrl;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not listening');
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return baseUrl;
}

async function post(endpoint: string, payload: PortalSubmission, requestId: string): Promise<Response> {
  const actorId = payload.patient.id;
  const idemKey = deriveIdempotencyKey(payload, actorId);
  const fingerprint = `${requestId}:${idemKey}`;
  const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signature}`,
      'content-type': 'application/json',
      'x-actor-type': 'patient',
      'x-actor-id': actorId,
      'x-request-id': requestId,
      'x-auth-scope': 'submit',
    },
    body: JSON.stringify(payload),
  });
}

describe('request limits', () => {
  beforeAll(async () => {
    delete process.env.NATS_URL;
    process.env.BUS_IMPL = 'memory';
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    getMessageBusForTest(); // ensure bus initialised
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (busImplBackup === undefined) {
      delete process.env.BUS_IMPL;
    } else {
      process.env.BUS_IMPL = busImplBackup;
    }
    if (natsUrlBackup === undefined) {
      delete process.env.NATS_URL;
    } else {
      process.env.NATS_URL = natsUrlBackup;
    }
    if (secretBackup === undefined) {
      delete process.env.SECURITY_SHARED_SECRET;
    } else {
      process.env.SECURITY_SHARED_SECRET = secretBackup;
    }
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
    if (envBackup === undefined) {
      delete process.env.MAX_BODY_BYTES;
    } else {
      process.env.MAX_BODY_BYTES = envBackup;
    }
  });

  it('rejects large payloads when MAX_BODY_BYTES is invalid', async () => {
    process.env.MAX_BODY_BYTES = 'not-a-number';
    const submission: PortalSubmission = {
      practiceId: 'p1',
      patient: { id: 'patient-123' },
      narrative: 'x'.repeat(300_000),
      channel: 'web' as const,
    };

    const res = await post(`${url()}/safety-check`, submission, 'req-body-limit');

    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body?.error?.code).toBe('payload_too_large');
  });

  it('accepts larger payloads when size suffix is provided', async () => {
    process.env.MAX_BODY_BYTES = '512k';
    const submission: PortalSubmission = {
      practiceId: 'p1',
      patient: { id: 'patient-123' },
      narrative: 'x'.repeat(400_000),
      channel: 'web' as const,
    };

    const res = await post(`${url()}/safety-check`, submission, 'req-size-suffix');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.outcome).toBe('SAFE_TO_CONTINUE');
  });
});
