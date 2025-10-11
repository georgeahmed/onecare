import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Topics, type AuditEvent, type TypedEnvelope } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';
import type { SecurityServices } from '@onecare/security';
import { resetSecurityServices, setSecurityServices } from '../src/adapters/security';

const submission = {
  practiceId: 'p1',
  patient: { id: 'patient-123' },
  narrative: 'example narrative',
  channel: 'web' as const,
};

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;
let bus: MessageBus;

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
    resetSecurityServices();
  });

  afterEach(() => {
    resetSecurityServices();
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
  });

  it('denies when authorization check fails', async () => {
    const verify = vi.fn<SecurityServices['verifySignatureAndReplayGuard']>().mockResolvedValue(true);
    const authorize = vi.fn<SecurityServices['authorize']>().mockResolvedValue(false);
    const consent = vi.fn<SecurityServices['checkConsent']>().mockResolvedValue(true);
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
  });

  it('denies when consent is not present', async () => {
    const verify = vi.fn<SecurityServices['verifySignatureAndReplayGuard']>().mockResolvedValue(true);
    const authorize = vi.fn<SecurityServices['authorize']>().mockResolvedValue(true);
    const consent = vi.fn<SecurityServices['checkConsent']>().mockResolvedValue(false);
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
  });
});
