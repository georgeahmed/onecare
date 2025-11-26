import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { Topics, type AuditEvent, type TypedEnvelope } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';
import type { SecurityServices } from '@onecare/security';
import type { AuditLedger, AuditEvent as LedgerAuditEvent } from '@onecare/ports';
import { getCounterRecords, getCounterTotal, resetMetrics } from '@onecare/observability';
import { deriveIdempotencyKey } from '../src/application/idempotency';
import { resetSecurityServices, setSecurityServices } from '../src/adapters/security';
import { setConsentFixtureEnv } from './consentFixture';
import { resetAuditLedger, setAuditLedger } from '../src/adapters/audit';
import { PRACTICE_ID } from './practice';

const submission = {
  practiceId: PRACTICE_ID,
  patient: { id: 'patient-123' },
  narrative: 'example narrative',
  channel: 'web' as const,
};

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;
let bus: MessageBus;
let auditEvents: LedgerAuditEvent[];
let resetIdempotencyStoreForTest: () => void;

function installAuditStub(): void {
  auditEvents = [];
  const stub: AuditLedger = {
    async write(event) {
      auditEvents.push(event);
    },
  };
  setAuditLedger(stub);
}

function baseUrl(): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server not listening');
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function subscribeAuditEvents(handler: (event: TypedEnvelope<AuditEvent>) => void): Promise<Subscription> {
  return bus.subscribe(Topics.audit.event, (msg) => {
    handler(msg.payload as TypedEnvelope<AuditEvent>);
  });
}

describe('zero-trust gate', () => {
  beforeAll(async () => {
    delete process.env.NATS_URL;
    process.env.BUS_IMPL = 'memory';
    const mod = await import('../src/index');
    server = mod.server;
    setBusReadyForTest = mod.setBusReadyForTest;
    bus = mod.getMessageBusForTest();
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
    setBusReadyForTest(true);
    setConsentFixtureEnv();
    resetSecurityServices();
    resetMetrics();
    installAuditStub();
  });

  afterEach(() => {
    resetSecurityServices();
    resetAuditLedger();
    vi.restoreAllMocks();
  });

  it('denies when authorization header is missing and emits audit event', async () => {
    const events: TypedEnvelope<AuditEvent>[] = [];
    const subscription = await subscribeAuditEvents((env) => {
      events.push(env);
    });

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': 'req-001',
      },
      body: JSON.stringify(submission),
    });

    await subscription.unsubscribe();

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json?.error?.code).toBe('forbidden');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.details?.reason).toBe('signature_invalid');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.type).toBe('orchestrator.access.denied');
    expect((auditEvents[0]?.payload as Record<string, unknown>)?.reason).toBe('signature_invalid');
  });

  it('denies when authorization check fails', async () => {
    const verify = vi.fn<SecurityServices['verifySignatureAndReplayGuard']>().mockResolvedValue(true);
    const authorize = vi.fn<SecurityServices['authorize']>().mockResolvedValue(false);
    const consent = vi.fn<SecurityServices['checkConsent']>().mockResolvedValue({ allowed: true, reason: 'granted' });
    setSecurityServices({ verifySignatureAndReplayGuard: verify, authorize, checkConsent: consent });
    const events: TypedEnvelope<AuditEvent>[] = [];
    const subscription = await subscribeAuditEvents((env) => events.push(env));

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': 'req-002',
      },
      body: JSON.stringify(submission),
    });

    await subscription.unsubscribe();

    expect(verify).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledOnce();
    expect(consent).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body?.error?.code).toBe('forbidden');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.details?.reason).toBe('not_authorized');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.type).toBe('orchestrator.access.denied');
    expect((auditEvents[0]?.payload as Record<string, unknown>)?.reason).toBe('not_authorized');
  });

  it('denies when consent is not present', async () => {
    const verify = vi.fn<SecurityServices['verifySignatureAndReplayGuard']>().mockResolvedValue(true);
    const authorize = vi.fn<SecurityServices['authorize']>().mockResolvedValue(true);
    const consent = vi.fn<SecurityServices['checkConsent']>().mockResolvedValue({ allowed: false, reason: 'not_found' });
    setSecurityServices({ verifySignatureAndReplayGuard: verify, authorize, checkConsent: consent });
    const events: TypedEnvelope<AuditEvent>[] = [];
    const subscription = await subscribeAuditEvents((env) => events.push(env));

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': 'req-003',
      },
      body: JSON.stringify(submission),
    });

    await subscription.unsubscribe();

    expect(verify).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledOnce();
    expect(consent).toHaveBeenCalledOnce();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body?.error?.code).toBe('forbidden');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.details?.reason).toBe('consent_denied');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.type).toBe('orchestrator.access.denied');
    expect((auditEvents[0]?.payload as Record<string, unknown>)?.reason).toBe('consent_denied');
  });
});

describe('orchestrator decision metrics', () => {
  let server: import('http').Server;
  let baseUrl: () => string;
  let setBusReadyForTest: (ready: boolean) => void;
  let teardownSecurity: () => void;

  beforeAll(async () => {
    delete process.env.NATS_URL;
    process.env.BUS_IMPL = 'memory';
    process.env.SECURITY_SHARED_SECRET = 'metrics-secret';
    const mod = await import('../src/index');
    server = mod.server;
    setBusReadyForTest = mod.setBusReadyForTest;
    resetIdempotencyStoreForTest = mod.resetIdempotencyStoreForTest;
    baseUrl = () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server not listening');
      }
      return `http://127.0.0.1:${(address as AddressInfo).port}`;
    };
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.SECURITY_SHARED_SECRET;
  });

  beforeEach(() => {
    resetMetrics();
    setBusReadyForTest(true);
    setConsentFixtureEnv();
    resetAuditLedger();
    resetIdempotencyStoreForTest();
    setSecurityServices({
      verifySignatureAndReplayGuard: vi.fn().mockResolvedValue(true),
      authorize: vi.fn().mockResolvedValue(true),
      checkConsent: vi
        .fn()
        .mockImplementation(async (patientId: string, purpose: string) => ({
          allowed: true,
          reason: 'granted',
          evidence: {
            reference: `Consent/${patientId}-${purpose}`,
            purpose,
            resources: ['QuestionnaireResponse', 'Communication'],
          },
        })),
    });
    teardownSecurity = () => {
      resetSecurityServices();
      vi.restoreAllMocks();
    };
  });

  afterEach(() => {
    teardownSecurity?.();
  });

  it('tracks decision attempts and outcomes for successful requests', async () => {
    const mod = await import('../src/adapters/services/safetyGate');
    vi.spyOn(mod, 'analyzePortalSubmission').mockResolvedValue({ outcome: 'SAFE_TO_CONTINUE' });

    const submissionInput = { practiceId: PRACTICE_ID, patient: { id: 'patient-123' }, narrative: 'metrics', channel: 'web' };
    const requestId = 'metrics-req-1';
    const idempotencyKey = deriveIdempotencyKey(submissionInput, submissionInput.patient.id);
    const fingerprint = `${requestId}:${idempotencyKey}`;
    const sharedSecret = process.env.SECURITY_SHARED_SECRET ?? '';
    const signature = createHmac('sha256', sharedSecret).update(fingerprint).digest('base64url');

    const response = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signature}`,
        'content-type': 'application/json',
        'x-actor-id': 'patient-123',
        'x-actor-type': 'patient',
        'x-request-id': requestId,
        'x-auth-scope': 'submit',
      },
      body: JSON.stringify(submissionInput),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ outcome: 'SAFE_TO_CONTINUE' });
    expect(getCounterTotal('orchestrator.decision.attempts')).toBe(1);
    expect(getCounterTotal('orchestrator.decision.failures')).toBe(0);
    const outcomes = getCounterRecords('orchestrator.decision.outcomes');
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: expect.objectContaining({ outcome: 'SAFE_TO_CONTINUE' }) }),
      ]),
    );
  });

  it('tracks decision failures when Safety Gate errors', async () => {
    const mod = await import('../src/adapters/services/safetyGate');
    vi.spyOn(mod, 'analyzePortalSubmission').mockRejectedValue(new Error('safety_gate_unavailable'));

    const submissionInput = { practiceId: PRACTICE_ID, patient: { id: 'patient-123' }, narrative: 'metrics', channel: 'web' };
    const requestId = 'metrics-req-2';
    const idempotencyKey = deriveIdempotencyKey(submissionInput, submissionInput.patient.id);
    const fingerprint = `${requestId}:${idempotencyKey}`;
    const sharedSecret = process.env.SECURITY_SHARED_SECRET ?? '';
    const signature = createHmac('sha256', sharedSecret).update(fingerprint).digest('base64url');

    const response = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signature}`,
        'content-type': 'application/json',
        'x-actor-id': 'patient-123',
        'x-actor-type': 'patient',
        'x-request-id': requestId,
        'x-auth-scope': 'submit',
      },
      body: JSON.stringify(submissionInput),
    });

    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(body?.error?.code).toBe('internal_error');
    expect(getCounterTotal('orchestrator.decision.attempts')).toBe(1);
    expect(getCounterTotal('orchestrator.decision.failures')).toBe(1);
  });
});
