import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { MessageBus } from '@onecare/bus';
import { Topics, type PortalSubmission } from '@onecare/events';
import { setConsentFixtureEnv } from './consentFixture';
import { resetSecurityServices, setSecurityServices } from '../src/adapters/security';
import { safePatientReference } from '../src/support/privacy';

vi.mock('../src/adapters/services/safetyGate', async () => {
  const actual = await vi.importActual<typeof import('../src/adapters/services/safetyGate')>(
    '../src/adapters/services/safetyGate'
  );
  return {
    ...actual,
    analyzePortalSubmission: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { outcome: 'SAFE_TO_CONTINUE' };
    }),
  };
});

const submission: PortalSubmission = {
  practiceId: 'p1',
  patient: { id: 'patient-123' },
  narrative: 'test narrative',
  channel: 'web',
};

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;
let setMessageBusForTest: (bus: MessageBus) => void;
let resetShutdownStateForTest: () => void;
let setShuttingDownForTest: (value: boolean) => void;
let originalBus: MessageBus;

function baseUrl(): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server not listening');
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function buildHeaders(requestId: string, overrides?: { idempotencyKey?: string }): Record<string, string> {
  const idemKey = overrides?.idempotencyKey ?? `${requestId}-idem`;
  const fingerprint = `${requestId}:${idemKey}`;
  const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');
  return {
    authorization: `Bearer ${signature}`,
    'content-type': 'application/json',
    'x-actor-id': submission.patient.id,
    'x-actor-type': 'patient',
    'x-request-id': requestId,
    'x-auth-scope': 'submit',
    'x-idempotency-key': idemKey,
  };
}

const SHARED_SECRET = 'resilience-secret';

describe('orchestrator resilience guardrails', () => {
  beforeAll(async () => {
    process.env.BUS_IMPL = 'memory';
    process.env.ORCHESTRATOR_MAX_CONCURRENCY_GLOBAL = '1';
    process.env.ORCHESTRATOR_MAX_CONCURRENCY_SAFETY = '1';
    process.env.ORCHESTRATOR_RATE_LIMIT_SAFETY_PER_MINUTE = '2';
    process.env.ORCHESTRATOR_RATE_LIMIT_SAFETY_WINDOW_MS = '1000';
    process.env.ORCHESTRATOR_BUS_PUBLISH_MAX_RETRIES = '1';
    process.env.ORCHESTRATOR_BUS_PUBLISH_BACKOFF_MS = '10';
    process.env.ORCHESTRATOR_BUS_PUBLISH_TIMEOUT_MS = '50';
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;

    const mod = await import('../src/index');
    server = mod.server;
    setBusReadyForTest = mod.setBusReadyForTest;
    setMessageBusForTest = mod.setMessageBusForTest;
    resetShutdownStateForTest = mod.resetShutdownStateForTest;
    setShuttingDownForTest = mod.setShuttingDownForTest;
    originalBus = mod.getMessageBusForTest();
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
    setBusReadyForTest(true);
    setMessageBusForTest(originalBus);
    resetShutdownStateForTest();
    setConsentFixtureEnv();
    setSecurityServices({
      verifySignatureAndReplayGuard: async () => true,
      authorize: async () => true,
      checkConsent: async () => ({
        allowed: true,
        reason: 'granted',
        evidence: {
          reference: `Consent/${submission.patient.id}-care`,
          purpose: 'care',
          resources: ['QuestionnaireResponse', 'Communication'],
        },
      }),
    });
  });

  afterEach(() => {
    resetSecurityServices();
  });

  it('returns busy when concurrency limits are exhausted', async () => {
    const first = fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-backpressure-1'),
      body: JSON.stringify(submission),
    });
    const second = fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-backpressure-2'),
      body: JSON.stringify(submission),
    });

    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect([firstRes.status, secondRes.status]).toContain(503);
    expect([firstRes.status, secondRes.status]).toContain(200);
    const failure = firstRes.status === 503 ? firstRes : secondRes;
    const json = await failure.json();
    expect(json?.error?.code).toBe('busy');
  });

  it('enforces rate limiting by actor', async () => {
    const allowedOne = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-rate-1'),
      body: JSON.stringify(submission),
    });
    expect(allowedOne.status).toBe(200);

    const allowedTwo = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-rate-2'),
      body: JSON.stringify(submission),
    });
    expect(allowedTwo.status).toBe(200);

    const limited = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-rate-3'),
      body: JSON.stringify(submission),
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const body = await limited.json();
    expect(body?.error?.code).toBe('too_many_requests');
  });

  it('routes failed publish attempts to the DLQ', async () => {
    const dlqMessages: Array<{ topic: string; payload: unknown }> = [];
    const publishStub = vi.fn(async (topic: string, payload: unknown, _headers?: Record<string, string>) => {
      if (topic === Topics.broker.deadLetter) {
        dlqMessages.push({ topic, payload });
        return;
      }
      throw new Error('bus_down');
    });
    const stubBus: MessageBus = {
      publish: publishStub,
      subscribe: async () => ({ unsubscribe: async () => {} }),
    };

    setMessageBusForTest(stubBus);

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-dlq-1'),
      body: JSON.stringify(submission),
    });

    expect(res.status).toBe(503);
    const dlqEntry = dlqMessages.find((entry) => entry.topic === Topics.broker.deadLetter);
    expect(dlqEntry).toBeDefined();
    const dlqEnvelope = dlqEntry?.payload as { payload?: { originalTopic?: string; payloadRef?: Record<string, unknown> } };
    const payload = dlqEnvelope?.payload;
    expect(payload?.originalTopic).toBe(Topics.triage.input);
    expect(payload?.payloadRef?.patientRef).toBe(safePatientReference(submission.patient.id));
  });

  it('rejects new requests while draining during shutdown', async () => {
    setShuttingDownForTest(true);

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: buildHeaders('req-shutdown'),
      body: JSON.stringify(submission),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body?.error?.code).toBe('busy');

    setShuttingDownForTest(false);
  });
});
