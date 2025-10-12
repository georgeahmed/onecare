import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import type { MessageBus } from '@onecare/bus';
import type { FhirRepository, QueueNotifier } from '@onecare/ports';
import { Topics } from '@onecare/events';
import {
  IntakeState,
  ScoredState,
  TaskCreatedState,
  DuplicateState,
  resetDedupCache,
  getDedupCacheSizeForTest,
  getDedupCacheEntryCountForTest,
  DEDUP_CACHE_LIMIT_FOR_TEST,
  type TriageContext,
  type DuplicateDetails,
} from '../src/application/triage.state';

function buildContext(scoreWeights: Partial<Record<string, number>>, features: Record<string, number>): TriageContext {
  const config: ResolvedConfig = {
    practiceId: 'demo',
    triage: { score_weights: scoreWeights },
  };

  return {
    id: 'triage-ctx',
    config,
    features,
  };
}

describe('IntakeState', () => {
  beforeEach(() => {
    resetDedupCache();
  });

  it('computes and stores the triage score in context before moving to Scored', async () => {
    const state = new IntakeState();
    const ctx = buildContext(
      { acuity: 1, risk: 0.5, complexity: 0.25, time: 0.4, capacity: 0.1 },
      { acuity: 0.9, risk: 0.6, complexity: 0.3, time: 0.5, capacity: 0.8 },
    );

    const next = await state.handle(ctx, { type: 'triage.evaluate' });

    const expected =
      1 * 0.9 +
      0.5 * 0.6 +
      0.25 * 0.3 +
      0.4 * 0.5 +
      0.1 * 0.8;

    expect(next).toBe('Scored');
    expect(ctx.score).toBeCloseTo(expected, 6);
  });

  it('marks submissions as duplicate when similar within the dedup window', async () => {
    const state = new IntakeState();
    const configWeights = { acuity: 1 };
    const baseContext = {
      id: 'triage-ctx',
      config: {
        practiceId: 'demo',
        triage: {
          score_weights: configWeights,
          dedup_window: 'PT2H',
          sim_threshold: 0.3,
        },
      } as ResolvedConfig,
      features: { acuity: 1 },
      patientId: 'patient-123',
      narrative: 'Patient reports chest pain and dizziness',
    };

    const firstCtx: TriageContext = { ...baseContext, now: 0 };
    const secondCtx: TriageContext = {
      ...baseContext,
      now: 30 * 60 * 1_000,
      narrative: 'Dizziness with chest pain continues',
    };

    await state.handle(firstCtx, { type: 'triage.evaluate' });
    const next = await state.handle(secondCtx, { type: 'triage.evaluate' });

    expect(next).toBe('Duplicate');
    expect(secondCtx.isDuplicate).toBe(true);
    expect(secondCtx.score).toBeUndefined();

    const duplicateState = new DuplicateState();
    await duplicateState.handle(secondCtx, { type: 'triage.evaluate' });

    expect(secondCtx.duplicateHandled).toBe(true);
  });

  it('does not flag submissions outside the dedup window or below similarity threshold', async () => {
    const state = new IntakeState();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        dedup_window: 'PT1H',
        sim_threshold: 0.7,
      },
    };

    const firstCtx: TriageContext = {
      id: 'ctx-one',
      config,
      features: { acuity: 1 },
      patientId: 'patient-456',
      narrative: 'Sore throat and mild fever',
      now: 0,
    };

    const dissimilarCtx: TriageContext = {
      id: 'ctx-two',
      config,
      features: { acuity: 0.5 },
      patientId: 'patient-456',
      narrative: 'Sprained ankle pain',
      now: 15 * 60 * 1_000,
    };

    const lateCtx: TriageContext = {
      id: 'ctx-three',
      config,
      features: { acuity: 0.6 },
      patientId: 'patient-456',
      narrative: 'Sore throat returning',
      now: 3 * 60 * 60 * 1_000,
    };

    await state.handle(firstCtx, { type: 'triage.evaluate' });
    await state.handle(dissimilarCtx, { type: 'triage.evaluate' });
    await state.handle(lateCtx, { type: 'triage.evaluate' });

    expect(dissimilarCtx.isDuplicate).not.toBe(true);
    expect(lateCtx.isDuplicate).not.toBe(true);
    expect(dissimilarCtx.score).toBeCloseTo(0.5, 6);
    expect(lateCtx.score).toBeCloseTo(0.6, 6);
  });

  it('prunes stale dedup entries when window elapses', async () => {
    const state = new IntakeState();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        dedup_window: 'PT1H',
        sim_threshold: 0.5,
      },
    };

    await state.handle(
      {
        id: 'first',
        config,
        features: { acuity: 1 },
        patientId: 'patient-old',
        narrative: 'Initial submission',
        now: 0,
      },
      { type: 'triage.evaluate' },
    );
    expect(getDedupCacheSizeForTest()).toBe(1);

    await state.handle(
      {
        id: 'second',
        config,
        features: { acuity: 0.8 },
        patientId: 'patient-new',
        narrative: 'New patient submission',
        now: 3 * 60 * 60 * 1_000,
      },
      { type: 'triage.evaluate' },
    );

    expect(getDedupCacheSizeForTest()).toBe(1);
    expect(getDedupCacheEntryCountForTest('patient-old')).toBe(0);
    expect(getDedupCacheEntryCountForTest('patient-new')).toBeGreaterThan(0);
  });

  it('caps per-patient dedup history to the configured limit', async () => {
    const state = new IntakeState();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        dedup_window: 'PT4H',
        sim_threshold: 0.9,
      },
    };

    const patientId = 'patient-limit';
    const runs = DEDUP_CACHE_LIMIT_FOR_TEST + 5;

    for (let i = 0; i < runs; i += 1) {
      await state.handle(
        {
          id: `ctx-${i}`,
          config,
          features: { acuity: 1 },
          patientId,
          narrative: `Submission ${i}`,
          now: i * 1_000,
        },
        { type: 'triage.evaluate' },
      );
    }

    expect(getDedupCacheEntryCountForTest(patientId)).toBeLessThanOrEqual(DEDUP_CACHE_LIMIT_FOR_TEST);
  });
});

describe('DuplicateState', () => {
  beforeEach(() => {
    resetDedupCache();
  });

  it('invokes provided duplicate handler with full details', async () => {
    const intake = new IntakeState();
    const duplicateState = new DuplicateState();
    const captured: DuplicateDetails[] = [];

    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        dedup_window: 'PT1H',
        sim_threshold: 0.2,
      },
    };

    const ctx: TriageContext = {
      id: 'triage-dup',
      config,
      features: { acuity: 1 },
      patientId: 'patient-dup',
      narrative: 'Severe headache and nausea',
      now: 0,
    };

    await intake.handle(ctx, { type: 'triage.evaluate' });

    const duplicateCtx: TriageContext = {
      ...ctx,
      id: 'triage-dup-2',
      narrative: 'Nausea with severe headache persists',
      now: 10 * 60 * 1_000,
      handleDuplicate: (details) => {
        captured.push(details);
      },
    };

    const outcome = await intake.handle(duplicateCtx, { type: 'triage.evaluate' });
    expect(outcome).toBe('Duplicate');

    const finalState = await duplicateState.handle(duplicateCtx, { type: 'triage.evaluate' });

    expect(finalState).toBe('Completed');
    expect(duplicateCtx.duplicateHandled).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].patientId).toBe('patient-dup');
    expect(captured[0].narrative).toContain('Nausea with severe headache');
    expect(captured[0].duplicateNarrative).toContain('Severe headache and nausea');
    expect(captured[0].windowMs).toBe(60 * 60 * 1_000);
    expect(captured[0].similarity).toBeGreaterThanOrEqual(0);
  });
});

describe('ScoredState', () => {
  it('derives priority from score and config thresholds', async () => {
    const scored = new ScoredState();
    const ctx: TriageContext = {
      id: 'priority-test',
      config: {
        practiceId: 'demo',
        triage: { score_weights: { acuity: 1 } },
        priority_thresholds: {
          stat: 0.95,
          urgent: 0.75,
          soon: 0.3,
          routine: 0,
        },
      },
      features: { acuity: 1 },
      score: 0.8,
    };

    const next = await scored.handle(ctx, { type: 'triage.evaluate' });

    expect(next).toBe('TaskCreated');
    expect(ctx.priority).toBe('URGENT');
  });
});

describe('TaskCreatedState', () => {
  beforeEach(() => {
    resetDedupCache();
  });

  it('creates a FHIR Task and publishes tasks.created event', async () => {
    const createTask = vi.fn().mockResolvedValue({ id: 'task-123', resourceType: 'Task' });
    const fhirRepository: FhirRepository = {
      upsertBundle: vi.fn(),
      createTask,
      createAppointment: vi.fn(),
      createDocumentReference: vi.fn(),
    };

    const publish = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const bus: MessageBus = {
      publish,
      subscribe: vi.fn(),
    };

    const queueNotifier: QueueNotifier = {
      notify,
    };

    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: { score_weights: { acuity: 1 } },
      priority_thresholds: {
        stat: 0.9,
        urgent: 0.7,
        soon: 0.4,
        routine: 0,
      },
    };

    const ctx: TriageContext = {
      id: 'task-created',
      config,
      features: { acuity: 0.75 },
      patientId: 'patient-001',
      taskOwner: 'Organization/demo-triage',
      correlationId: 'corr-abc',
      fhirRepository,
      bus,
      queueNotifier,
      queueName: 'triage.escalations',
      now: 0,
    };

    const intake = new IntakeState();
    await intake.handle(ctx, { type: 'triage.evaluate' });

    const scored = new ScoredState();
    await scored.handle(ctx, { type: 'triage.evaluate' });

    const state = new TaskCreatedState();
    const next = await state.handle(ctx, { type: 'triage.evaluate' });

    expect(next).toBe('Notified');
    expect(createTask).toHaveBeenCalledTimes(1);
    const taskPayload = createTask.mock.calls[0][0] as Record<string, unknown>;
    expect(taskPayload.resourceType).toBe('Task');
    expect(taskPayload.priority).toBe('urgent');
    expect(taskPayload.for).toEqual({ reference: 'Patient/patient-001' });
    expect(taskPayload.owner).toEqual({ reference: 'Organization/demo-triage' });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      Topics.tasks.created,
      expect.objectContaining({
        payload: expect.objectContaining({
          taskId: 'task-123',
          patientId: 'patient-001',
          priority: 'URGENT',
          owner: 'Organization/demo-triage',
        }),
        correlationId: 'corr-abc',
      }),
      { 'x-correlation-id': 'corr-abc' },
    );

    expect(ctx.taskId).toBe('task-123');
    expect(ctx.taskEventPublished).toBe(true);
    expect(ctx.priority).toBe('URGENT');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'triage.escalations',
      expect.objectContaining({
        taskId: 'task-123',
        patientId: 'patient-001',
        priority: 'URGENT',
      }),
    );
  });
});
