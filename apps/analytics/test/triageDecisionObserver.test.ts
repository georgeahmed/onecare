import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import { Topics, createEnvelope, type TriageDecision } from '@onecare/events';
import { getCounterRecords, resetMetrics } from '@onecare/observability';
import { TriageDecisionObserver } from '../src/triageDecisionObserver';

describe('TriageDecisionObserver', () => {
  let bus: MemoryBus;

  beforeEach(() => {
    bus = new MemoryBus();
    resetMetrics();
  });

  it('records counters for valid decisions and logs without throwing', async () => {
    const observer = new TriageDecisionObserver({ bus });
    await observer.start();

    const decision: TriageDecision = {
      patientId: 'patient-123',
      score: 0.85,
      priority: 'URGENT',
      duplicateOf: 'patient-123:12345',
      reasons: ['acuity_high'],
      assignment: { owner: 'Organization/demo-triage' },
    };

    const envelope = createEnvelope(Topics.triage.decision ?? 'triage.decision', decision, 'corr-observer');
    await bus.publish(Topics.triage.decision ?? 'triage.decision', envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(getCounterRecords('analytics.triage_decision.observed_total')).toHaveLength(1);
    expect(getCounterRecords('analytics.triage_decision.duplicate_total')).toHaveLength(1);

    await observer.stop();
  });

  it('ignores invalid payloads without recording counters', async () => {
    const observer = new TriageDecisionObserver({ bus });
    await observer.start();

    const invalidPayload = { priority: 'UNKNOWN' } as unknown as TriageDecision;
    const envelope = createEnvelope(Topics.triage.decision ?? 'triage.decision', invalidPayload, 'corr-invalid');

    await bus.publish(Topics.triage.decision ?? 'triage.decision', envelope, { 'x-correlation-id': '' });

    expect(getCounterRecords('analytics.triage_decision.observed_total')).toHaveLength(0);
    expect(getCounterRecords('analytics.triage_decision.duplicate_total')).toHaveLength(0);
    expect(getCounterRecords('analytics.triage_decision.invalid_total')).toHaveLength(1);

    await observer.stop();
  });

  it('suppresses replayed envelopes via idempotency guard', async () => {
    const observer = new TriageDecisionObserver({ bus });
    await observer.start();

    const decision: TriageDecision = {
      patientId: 'patient-999',
      score: 0.42,
      priority: 'ROUTINE',
    };

    const envelope = createEnvelope(Topics.triage.decision ?? 'triage.decision', decision, 'corr-replay');
    await bus.publish(Topics.triage.decision ?? 'triage.decision', envelope, { 'x-correlation-id': envelope.correlationId ?? '' });
    await bus.publish(Topics.triage.decision ?? 'triage.decision', envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(getCounterRecords('analytics.triage_decision.observed_total')).toHaveLength(1);
    expect(getCounterRecords('analytics.triage_decision.replay_suppressed_total')).toHaveLength(1);

    await observer.stop();
  });
});
