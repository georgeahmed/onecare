import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { Topics, type PortalSubmission, type TaskCreated, type TriageInput, type TypedEnvelope, createEnvelope } from '@onecare/events';
import type { MessageBus, Subscription } from '@onecare/bus';
import type { AuditEvent as LedgerAuditEvent, AuditLedger } from '@onecare/ports';
import { deriveIdempotencyKey } from '../../src/application/idempotency';
import { resetSecurityServices } from '../../src/adapters/security';
import { resetAuditLedger, setAuditLedger } from '../../src/adapters/audit';
import { setConsentFixtureEnv } from '../consentFixture';

vi.mock('../../src/adapters/services/safetyGate', () => ({
  analyzePortalSubmission: vi.fn(),
}));

import { analyzePortalSubmission } from '../../src/adapters/services/safetyGate';

const analyzePortalSubmissionMock = vi.mocked(analyzePortalSubmission);

const SHARED_SECRET = 'triage-e2e-secret';

describe('triage flow e2e', () => {
  let server: import('http').Server;
  let getMessageBusForTest: () => MessageBus;
  let setBusReadyForTest: (ready: boolean) => void;
  let resetIdempotencyStoreForTest: () => void;
  let bus: MessageBus;
  let triageSubscription: Subscription | undefined;
  let tasksSubscription: Subscription | undefined;
  let triageEvents: TypedEnvelope<TriageInput>[];
  let taskEvents: TypedEnvelope<TaskCreated>[];
  let auditEvents: LedgerAuditEvent[];

  const submission: PortalSubmission = {
    practiceId: 'demo',
    patient: { id: 'patient-42' },
    narrative: 'triage flow e2e narrative',
    channel: 'web',
  };

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

  beforeAll(async () => {
    delete process.env.NATS_URL;
    process.env.BUS_IMPL = 'memory';
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    const mod = await import('../../src/index');
    server = mod.server;
    getMessageBusForTest = mod.getMessageBusForTest;
    setBusReadyForTest = mod.setBusReadyForTest;
    resetIdempotencyStoreForTest = mod.resetIdempotencyStoreForTest;
    bus = getMessageBusForTest();

    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.SECURITY_SHARED_SECRET;
  });

  beforeEach(async () => {
    setBusReadyForTest(true);
    resetIdempotencyStoreForTest();
    setConsentFixtureEnv();
    resetSecurityServices();
    installAuditStub();
    process.env.SECURITY_SHARED_SECRET = SHARED_SECRET;
    triageEvents = [];
    taskEvents = [];

    triageSubscription = await bus.subscribe<TypedEnvelope<TriageInput>>(Topics.triage.input, async (msg) => {
      triageEvents.push(msg.payload);
      const triageEnvelope = msg.payload;
      const payload: TaskCreated = {
        taskId: `task-${triageEnvelope.payload.patientId}`,
        patientId: triageEnvelope.payload.patientId,
        priority: 'URGENT',
        owner: 'Organization/demo-triage',
      };
      const taskEnvelope = createEnvelope(Topics.tasks.created, payload, triageEnvelope.correlationId);
      await bus.publish(taskEnvelope.topic, taskEnvelope);
    });

    tasksSubscription = await bus.subscribe<TypedEnvelope<TaskCreated>>(Topics.tasks.created, async (msg) => {
      taskEvents.push(msg.payload);
    });
  });

  afterEach(async () => {
    await triageSubscription?.unsubscribe();
    await tasksSubscription?.unsubscribe();
    triageSubscription = undefined;
    tasksSubscription = undefined;
    vi.clearAllMocks();
    resetAuditLedger();
  });

  it('publishes triage.input and tasks.created with correlation propagation on SAFE outcome', async () => {
    analyzePortalSubmissionMock.mockResolvedValue({ outcome: 'SAFE_TO_CONTINUE' });
    const correlationId = 'corr-e2e-safe';
    const requestId = 'req-e2e-safe';
    const idemKey = deriveIdempotencyKey(submission, submission.patient.id);
    const fingerprint = `${requestId}:${idemKey}`;
    const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');

    const response = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signature}`,
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': requestId,
        'x-auth-scope': 'submit',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(submission),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    const decision = (await response.json()) as { outcome: string };
    expect(decision.outcome).toBe('SAFE_TO_CONTINUE');

    expect(triageEvents).toHaveLength(1);
    const triageEnvelope = triageEvents[0]!;
    expect(triageEnvelope.topic).toBe(Topics.triage.input);
    expect(triageEnvelope.correlationId).toBe(correlationId);
    expect(triageEnvelope.payload.patientId).toBe(submission.patient.id);
    expect(triageEnvelope.payload.narrative).toBe(submission.narrative);

    expect(taskEvents).toHaveLength(1);
    const taskEnvelope = taskEvents[0]!;
    expect(taskEnvelope.topic).toBe(Topics.tasks.created);
    expect(taskEnvelope.correlationId).toBe(correlationId);
    expect(taskEnvelope.payload.patientId).toBe(submission.patient.id);
    expect(taskEnvelope.payload.priority).toBe('URGENT');

    expect(auditEvents.some((event) => event.type === 'orchestrator.access.success')).toBe(true);
  });

  it('skips triage publishing when Safety Gate diverts', async () => {
    analyzePortalSubmissionMock.mockResolvedValue({ outcome: 'DIVERTED', reason: 'EMERGENCY' });
    const correlationId = 'corr-e2e-diverted';
    const requestId = 'req-e2e-diverted';
    const idemKey = deriveIdempotencyKey(submission, submission.patient.id);
    const fingerprint = `${requestId}:${idemKey}`;
    const signature = createHmac('sha256', SHARED_SECRET).update(fingerprint).digest('base64url');

    const response = await fetch(`${baseUrl()}/safety-check`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signature}`,
        'content-type': 'application/json',
        'x-actor-id': submission.patient.id,
        'x-actor-type': 'patient',
        'x-request-id': requestId,
        'x-auth-scope': 'submit',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(submission),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    const decision = (await response.json()) as { outcome: string };
    expect(decision.outcome).toBe('DIVERTED');

    expect(triageEvents).toHaveLength(0);
    expect(taskEvents).toHaveLength(0);
  });
});
