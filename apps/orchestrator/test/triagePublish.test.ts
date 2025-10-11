import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { TypedEnvelope, TriageInput, SafetyDecision } from '@onecare/events';
import { Topics } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';
import type { AuditLedger, AuditEvent as LedgerAuditEvent } from '@onecare/ports';
import { resetAuditLedger, setAuditLedger } from '../src/adapters/audit';

vi.mock('../src/adapters/services/safetyGate', async () => {
  const actual = await vi.importActual<typeof import('../src/adapters/services/safetyGate')>(
    '../src/adapters/services/safetyGate'
  );
  return {
    ...actual,
    analyzePortalSubmission: vi.fn<() => Promise<SafetyDecision>>().mockResolvedValue({
      outcome: 'SAFE_TO_CONTINUE',
    }),
  };
});

const submission = {
  practiceId: 'p1',
  patient: { id: 'patient-123' },
  narrative: 'non emergency narrative',
  channel: 'web' as const,
};

let server: import('http').Server;
let setBusReadyForTest: (ready: boolean) => void;
let bus: MessageBus;
let auditEvents: LedgerAuditEvent[];

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

async function subscribeTriage(handler: (envelope: TypedEnvelope<TriageInput>) => void): Promise<Subscription> {
  return bus.subscribe<TypedEnvelope<TriageInput>>(Topics.triage.input, (msg) => {
    handler(msg.payload);
  });
}

describe('triage input publishing', () => {
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
    installAuditStub();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAuditLedger();
  });

  it('publishes triage.input when safety gate outcome is SAFE_TO_CONTINUE', async () => {
    const envelopes: TypedEnvelope<TriageInput>[] = [];
    const subscription = await subscribeTriage((envelope) => {
      envelopes.push(envelope);
    });

    const res = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': 'triage-test-req',
        'x-auth-scope': 'submit',
      },
      body: JSON.stringify(submission),
    });

    await subscription.unsubscribe();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.outcome).toBe('SAFE_TO_CONTINUE');

    expect(envelopes).toHaveLength(1);
    const [envelope] = envelopes;
    expect(envelope.topic).toBe(Topics.triage.input);
    expect(envelope.payload.patientId).toBe(submission.patient.id);
    expect(envelope.payload.narrative).toBe(submission.narrative);
    expect(envelope.correlationId).toBeDefined();
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.type).toBe('orchestrator.access.success');
    const payload = auditEvents[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.patientId).toBe(submission.patient.id);
    expect(payload?.outcome).toBe('SAFE_TO_CONTINUE');
  });
});
