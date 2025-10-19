import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import type { MessageBus } from '@onecare/bus';
import type { FeatureStore, FhirRepository, QueueNotifier, IdempotencyStore } from '@onecare/ports';
import { Topics } from '@onecare/events';
import { resetMetrics, getCounterRecords, getHistogramRecords } from '@onecare/observability';
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
  type AssignmentConsentEvaluator,
} from '../src/application/triage.state';
import { assertValidTriageInput, TriageContractValidationError } from '../src/application/contracts';
import { computeTriageScore } from '../src/application/scoring';

const defaultFallbackConfig = () => ({
  enabled: true,
  timeBudgetMs: 120,
  scoreDeltaTolerance: 0.2,
  maxReasons: 5,
});

function ensureFallbackConfig(config: ResolvedConfig): void {
  const fallback = config.triageFallback ? { ...config.triageFallback } : defaultFallbackConfig();
  config.triageFallback = { ...fallback };
  if (!config.priority_thresholds) {
    config.priority_thresholds = {
      stat: 0.9,
      urgent: 0.7,
      soon: 0.4,
      routine: 0,
    };
  }
  if (!Array.isArray(config.red_flag_set)) {
    config.red_flag_set = [];
  }
  if (!config.triage || typeof config.triage !== 'object') {
    config.triage = { fallback: { ...fallback } };
  } else {
    (config.triage as Record<string, unknown>).fallback = { ...fallback };
  }
}

function buildContext(scoreWeights: Partial<Record<string, number>>, features: Record<string, number>): TriageContext {
  const config: ResolvedConfig = {
    practiceId: 'demo',
    triage: { score_weights: scoreWeights },
  };
  ensureFallbackConfig(config);

  const baseFeatures = { ...features };
  const triageInput = {
    patientId: 'patient-default',
    narrative: 'Default narrative describing symptoms',
    features: baseFeatures,
  };

  return {
    id: 'triage-ctx',
    config,
    features: baseFeatures,
    rawFeatures: baseFeatures,
    patientId: triageInput.patientId,
    narrative: triageInput.narrative,
    triageInput,
  };
}

function createTriageContext(options: {
  id: string;
  config: ResolvedConfig;
  patientId: string;
  narrative: string;
  features: Record<string, number>;
  now?: number;
}): TriageContext {
  ensureFallbackConfig(options.config);
  const featureCopy = { ...options.features };
  const base: TriageContext = {
    id: options.id,
    config: options.config,
    features: featureCopy,
    rawFeatures: featureCopy,
    patientId: options.patientId,
    narrative: options.narrative,
    triageInput: {
      patientId: options.patientId,
      narrative: options.narrative,
      features: featureCopy,
    },
  };
  if (options.now !== undefined) {
    base.now = options.now;
  }
  return base;
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, boolean>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string) => {
      keys.set(key, true);
    },
    reserve: async (key: string) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, true);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

describe('IntakeState', () => {
  beforeEach(() => {
    resetDedupCache();
    resetMetrics();
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
    expect(ctx.score).toBeCloseTo(1, 6);
  });

  it('marks submissions as duplicate when similar within the dedup window', async () => {
    const state = new IntakeState();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        dedup_window: 'PT2H',
        sim_threshold: 0.3,
      },
    };

    const firstCtx = createTriageContext({
      id: 'triage-ctx-one',
      config,
      patientId: 'patient-123',
      narrative: 'Patient reports chest pain and dizziness',
      features: { acuity: 1 },
      now: 0,
    });
    const secondCtx = createTriageContext({
      id: 'triage-ctx-two',
      config,
      patientId: 'patient-123',
      narrative: 'Dizziness with chest pain continues',
      features: { acuity: 1 },
      now: 30 * 60 * 1_000,
    });

    await state.handle(firstCtx, { type: 'triage.evaluate' });
    const next = await state.handle(secondCtx, { type: 'triage.evaluate' });

    expect(next).toBe('Duplicate');
    expect(secondCtx.isDuplicate).toBe(true);
    expect(secondCtx.score).toBeUndefined();

    const duplicateState = new DuplicateState();
    await duplicateState.handle(secondCtx, { type: 'triage.evaluate' });

    expect(secondCtx.duplicateHandled).toBe(true);
  });

  it('throws when the triage input payload violates the contract', async () => {
    const state = new IntakeState();
    const ctx = buildContext({ acuity: 1 }, { acuity: 0.4 });
    ctx.triageInput = {
      narrative: 'No patient id present',
      features: ctx.triageInput?.features,
    } as unknown as typeof ctx.triageInput;
    ctx.patientId = undefined;
    ctx.narrative = 'No patient id present';

    expect(() => assertValidTriageInput(ctx.triageInput as any)).toThrow(TriageContractValidationError);

    await expect(state.handle(ctx, { type: 'triage.evaluate' })).rejects.toBeInstanceOf(
      TriageContractValidationError,
    );
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

    const firstCtx = createTriageContext({
      id: 'ctx-one',
      config,
      features: { acuity: 1 },
      patientId: 'patient-456',
      narrative: 'Sore throat and mild fever',
      now: 0,
    });

    const dissimilarCtx = createTriageContext({
      id: 'ctx-two',
      config,
      features: { acuity: 0.5 },
      patientId: 'patient-456',
      narrative: 'Sprained ankle pain',
      now: 15 * 60 * 1_000,
    });

    const lateCtx = createTriageContext({
      id: 'ctx-three',
      config,
      features: { acuity: 0.6 },
      patientId: 'patient-456',
      narrative: 'Sore throat returning',
      now: 3 * 60 * 60 * 1_000,
    });

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
      createTriageContext({
        id: 'first',
        config,
        features: { acuity: 1 },
        patientId: 'patient-old',
        narrative: 'Initial submission',
        now: 0,
      }),
      { type: 'triage.evaluate' },
    );
    expect(getDedupCacheSizeForTest()).toBe(1);

    await state.handle(
      createTriageContext({
        id: 'second',
        config,
        features: { acuity: 0.8 },
        patientId: 'patient-new',
        narrative: 'New patient submission',
        now: 3 * 60 * 60 * 1_000,
      }),
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
        createTriageContext({
          id: `ctx-${i}`,
          config,
          features: { acuity: 1 },
          patientId,
          narrative: `Submission ${i}`,
          now: i * 1_000,
        }),
        { type: 'triage.evaluate' },
      );
    }

    expect(getDedupCacheEntryCountForTest(patientId)).toBeLessThanOrEqual(DEDUP_CACHE_LIMIT_FOR_TEST);
  });

  it('applies rules fallback when an ML dependency is unavailable', async () => {
    const state = new IntakeState();
    const fallback = defaultFallbackConfig();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        fallback: { ...fallback },
        dedup_window: 'PT1H',
        sim_threshold: 0.5,
      },
      triageFallback: { ...fallback },
      priority_thresholds: {
        stat: 0.9,
        urgent: 0.7,
        soon: 0.4,
        routine: 0,
      },
      red_flag_set: ['chest pain'],
    };

    const ctx = createTriageContext({
      id: 'ml-fallback',
      config,
      features: {},
      patientId: 'patient-fallback',
      narrative: 'Patient reports sudden chest pain and dizziness',
      now: 0,
    });
    ctx.correlationId = 'corr-rules';
    ctx.triageInput = {
      patientId: 'patient-fallback',
      narrative: ctx.narrative!,
    };
    ctx.mlDependencies = { acuity: 'circuit_open' };

    const next = await state.handle(ctx, { type: 'triage.evaluate' });
    expect(next).toBe('Scored');
    expect(ctx.scoreSource).toBe('rules');
    expect(ctx.fallbackApplied).toBe(true);
    expect(ctx.decisionReasons).toContain('rule:fallback:ml_acuity_circuit_open');
    expect(ctx.decisionReasons).toContain('rule:red_flag:chest_pain');
    expect(ctx.score).toBeGreaterThanOrEqual(0.9);

    const scored = new ScoredState();
    const following = await scored.handle(ctx, { type: 'triage.evaluate' });
    expect(following).toBe('TaskCreated');
    expect(ctx.priority).toBe('STAT');

    const decisionRecords = getCounterRecords('triage.score.decision');
    const lastDecision = decisionRecords.at(-1);
    expect(lastDecision?.attributes).toMatchObject({
      priority: 'STAT',
      source: 'rules',
      fallback: 'yes',
      correlationId: 'corr-rules',
    });
    const scoreDurations = getHistogramRecords('triage.score.duration_ms');
    expect(scoreDurations.at(-1)?.attributes?.correlationId).toBe('corr-rules');
    const dedupDurations = getHistogramRecords('triage.dedup.duration_ms');
    expect(dedupDurations.at(-1)?.attributes?.correlationId).toBe('corr-rules');
  });

  it('keeps ML-derived score when dependencies are healthy', async () => {
    const state = new IntakeState();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: { score_weights: { acuity: 1, risk: 0.5, time: 0.3, complexity: 0.2, capacity: 0.1 } },
    };
    ensureFallbackConfig(config);

    const ctx = createTriageContext({
      id: 'ml-healthy',
      config,
      patientId: 'patient-healthy',
      narrative: 'Mild sore throat for two days',
      features: { acuity: 0.6, risk: 0.3, time: 0.4, complexity: 0.2, capacity: 0.5 },
      now: 0,
    });
    ctx.mlDependencies = { acuity: 'ok', similarity: 'ok' };
    ctx.correlationId = 'corr-ml';

    const expectedScore = computeTriageScore(config, ctx.features);
    const next = await state.handle(ctx, { type: 'triage.evaluate' });

    expect(next).toBe('Scored');
    expect(ctx.scoreSource).toBe('ml');
    expect(ctx.fallbackApplied).toBe(false);
    expect(ctx.decisionReasons).toBeUndefined();
    expect(ctx.score).toBeCloseTo(expectedScore, 6);

    const scored = new ScoredState();
    await scored.handle(ctx, { type: 'triage.evaluate' });
    const decisionRecords = getCounterRecords('triage.score.decision');
    const lastDecision = decisionRecords.at(-1);
    expect(lastDecision?.attributes).toMatchObject({
      source: 'ml',
      fallback: 'no',
      correlationId: 'corr-ml',
    });
    const scoreDurations = getHistogramRecords('triage.score.duration_ms');
    expect(scoreDurations.at(-1)?.attributes?.correlationId).toBe('corr-ml');
  });

  it('falls back to rules when features are missing', async () => {
    const state = new IntakeState();
    const fallback = defaultFallbackConfig();
    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: {
        score_weights: { acuity: 1 },
        fallback: { ...fallback },
      },
      triageFallback: { ...fallback },
      priority_thresholds: {
        stat: 0.9,
        urgent: 0.7,
        soon: 0.4,
        routine: 0,
      },
      red_flag_set: [],
    };

    const ctx = createTriageContext({
      id: 'features-missing',
      config,
      patientId: 'patient-missing',
      narrative: 'General malaise',
      features: {},
      now: 0,
    });
    ctx.triageInput = {
      patientId: 'patient-missing',
      narrative: ctx.narrative!,
    };

    const next = await state.handle(ctx, { type: 'triage.evaluate' });

    expect(next).toBe('Scored');
    expect(ctx.scoreSource).toBe('rules');
    expect(ctx.fallbackApplied).toBe(true);
    expect(ctx.decisionReasons).toContain('rule:fallback:ml_features_missing');
  });
});

describe('DuplicateState', () => {
  beforeEach(() => {
    resetDedupCache();
    resetMetrics();
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

    const ctx = createTriageContext({
      id: 'triage-dup',
      config,
      features: { acuity: 1 },
      patientId: 'patient-dup',
      narrative: 'Severe headache and nausea',
      now: 0,
    });

    await intake.handle(ctx, { type: 'triage.evaluate' });

    const duplicateCtx: TriageContext = {
      ...ctx,
      id: 'triage-dup-2',
      narrative: 'Nausea with severe headache persists',
      triageInput: {
        patientId: ctx.patientId!,
        narrative: 'Nausea with severe headache persists',
        features: ctx.rawFeatures ?? ctx.features,
      },
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
  beforeEach(() => {
    resetMetrics();
  });
  class FakeFeatureStore implements FeatureStore {
    public readonly records = new Map<string, Record<string, unknown>>();
    async putFeatures(key: string, features: Record<string, unknown>): Promise<void> {
      this.records.set(key, features);
    }
    async getFeatures(key: string): Promise<Record<string, unknown> | null> {
      return this.records.get(key) ?? null;
    }
  }

  afterEach(() => {
    delete process.env.FEATURE_LOGGING;
  });

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
      rawFeatures: { acuity: 1 },
      patientId: 'patient-priority',
      narrative: 'Priority evaluation',
      triageInput: {
        patientId: 'patient-priority',
        narrative: 'Priority evaluation',
        features: { acuity: 1 },
      },
      score: 0.8,
    };

    const next = await scored.handle(ctx, { type: 'triage.evaluate' });

    expect(next).toBe('TaskCreated');
    expect(ctx.priority).toBe('URGENT');
  });

  it('logs feature vectors when logging enabled and store provided', async () => {
    process.env.FEATURE_LOGGING = 'true';
    const scored = new ScoredState();
    const store = new FakeFeatureStore();
    const ctx: TriageContext = {
      id: 'feature-log',
      config: {
        practiceId: 'demo',
        triage: { score_weights: { acuity: 1 } },
        priority_thresholds: {
          stat: 0.9,
          urgent: 0.7,
          soon: 0.3,
          routine: 0,
        },
      },
      features: { acuity: 0.8 },
      rawFeatures: { acuity: 0.8 },
      score: 0.8,
      patientId: 'patient-100',
      narrative: 'Feature logging test',
      correlationId: 'corr-xyz',
      featureStore: store,
      triageInput: {
        patientId: 'patient-100',
        narrative: 'Feature logging test',
        features: { acuity: 0.8 },
      },
    };

    await scored.handle(ctx, { type: 'triage.evaluate' });

    const record = await store.getFeatures('triage:patient-100:corr-xyz');
    expect(record).not.toBeNull();
    expect(record?.source).toBe('triage');
    expect(record?.metadata).toMatchObject({ score: 0.8, priority: 'URGENT' });
    expect(record?.features).toMatchObject({ acuity: 0.8 });
  });
});

describe('TaskCreatedState', () => {
  beforeEach(() => {
    resetDedupCache();
    resetMetrics();
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
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
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
      rawFeatures: { acuity: 0.75 },
      patientId: 'patient-001',
      narrative: 'Triage narrative for patient',
      taskOwner: 'Organization/demo-triage',
      correlationId: 'corr-abc',
      fhirRepository,
      bus,
      queueNotifier,
      queueName: 'triage.escalations',
      now: 0,
      triageInput: {
        patientId: 'patient-001',
        narrative: 'Triage narrative for patient',
        features: { acuity: 0.75 },
      },
    };

    const intake = new IntakeState();
    await intake.handle(ctx, { type: 'triage.evaluate' });

    const scored = new ScoredState();
    await scored.handle(ctx, { type: 'triage.evaluate' });

    const state = new TaskCreatedState();
    const next = await state.handle(ctx, { type: 'triage.evaluate' });

    expect(next).toBe('Notified');
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]).toHaveLength(2);
    const [taskPayload, taskOptions] = createTask.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(taskPayload.resourceType).toBe('Task');
    expect(taskPayload.priority).toBe('urgent');
    expect(taskPayload.for).toEqual({ reference: 'Patient/patient-001' });
    expect(taskPayload.owner).toEqual({ reference: 'Organization/demo-triage' });
    expect(taskOptions?.idempotencyKey).toBe('triage:task:patient-001:corr-abc');
    expect(taskOptions?.signal).toBeInstanceOf(AbortSignal);

    expect(publish).toHaveBeenCalledTimes(2);
    const [decisionCall, taskCall] = publish.mock.calls;
    expect(decisionCall[0]).toBe(Topics.triage.decision ?? 'triage.decision');
    expect(decisionCall[1]).toMatchObject({
      correlationId: 'corr-abc',
      payload: {
        patientId: 'patient-001',
        priority: 'URGENT',
      },
    });
    expect(taskCall[0]).toBe(Topics.tasks.created);
    expect(taskCall[1]).toMatchObject({
      correlationId: 'corr-abc',
      payload: {
        taskId: 'task-123',
        patientId: 'patient-001',
        priority: 'URGENT',
      },
    });
    expect(taskCall[2]).toMatchObject({ 'x-correlation-id': 'corr-abc' });

    expect(ctx.taskId).toBe('task-123');
    expect(ctx.taskEventPublished).toBe(true);
    expect(ctx.priority).toBe('URGENT');
    expect(ctx.decision).toMatchObject({
      patientId: 'patient-001',
      priority: 'URGENT',
    });
    expect(ctx.decision?.assignment).toBeUndefined();
    expect(ctx.decision?.features).toBeUndefined();
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

  it('suppresses duplicate task creation when idempotency key repeats', async () => {
    const store = createIdempotencyStore();
    const createTask = vi.fn().mockResolvedValue({ id: 'task-abc', resourceType: 'Task' });
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
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    };

    const queueNotifier: QueueNotifier = { notify };

    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: { score_weights: { acuity: 1 } },
      priority_thresholds: { stat: 0.9, urgent: 0.7, soon: 0.4, routine: 0 },
    };

    const ctx: TriageContext = {
      id: 'task-dup',
      config,
      features: { acuity: 0.8 },
      rawFeatures: { acuity: 0.8 },
      patientId: 'patient-dup',
      narrative: 'Primary triage narrative',
      taskOwner: 'Organization/demo-triage',
      correlationId: 'corr-dup',
      fhirRepository,
      bus,
      queueNotifier,
      queueName: 'triage.escalations',
      idempotencyStore: store,
      idempotencyKey: 'triage:task:patient-dup',
      triageInput: {
        patientId: 'patient-dup',
        narrative: 'Primary triage narrative',
        features: { acuity: 0.8 },
      },
    };

    const intake = new IntakeState();
    await intake.handle(ctx, { type: 'triage.evaluate' });
    const scored = new ScoredState();
    await scored.handle(ctx, { type: 'triage.evaluate' });

    const creator = new TaskCreatedState();
    await creator.handle(ctx, { type: 'triage.evaluate' });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ctx.decision).toBeDefined();

    let taskSuccessRecords = getCounterRecords('triage.task.create.success');
    expect(taskSuccessRecords).toHaveLength(1);
    expect(taskSuccessRecords[0].attributes).toMatchObject({
      owner: 'Organization/demo-triage',
      correlationId: 'corr-dup',
    });
    let taskDurationRecords = getHistogramRecords('triage.task.create.duration_ms');
    expect(taskDurationRecords.at(-1)?.attributes?.correlationId).toBe('corr-dup');
    let notifySuccessRecords = getCounterRecords('triage.notify.success');
    expect(notifySuccessRecords).toHaveLength(1);
    expect(notifySuccessRecords[0].attributes).toMatchObject({
      queue: 'triage.escalations',
      correlationId: 'corr-dup',
    });
    let notifyDurationRecords = getHistogramRecords('triage.notify.duration_ms');
    expect(notifyDurationRecords.at(-1)?.attributes?.correlationId).toBe('corr-dup');

    const duplicateCtx: TriageContext = {
      ...ctx,
      taskReference: undefined,
      taskId: undefined,
      taskEventPublished: undefined,
    };

    await creator.handle(duplicateCtx, { type: 'triage.evaluate' });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    taskSuccessRecords = getCounterRecords('triage.task.create.success');
    expect(taskSuccessRecords).toHaveLength(1);
    taskDurationRecords = getHistogramRecords('triage.task.create.duration_ms');
    expect(taskDurationRecords).toHaveLength(1);
  });

  it('aborts task creation when consent is denied', async () => {
    const createTask = vi.fn();
    const fhirRepository: FhirRepository = {
      upsertBundle: vi.fn(),
      createTask,
      createAppointment: vi.fn(),
      createDocumentReference: vi.fn(),
    };

    const publish = vi.fn().mockResolvedValue(undefined);
    const bus: MessageBus = {
      publish,
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    };

    const consentEvaluator: AssignmentConsentEvaluator = {
      check: vi.fn().mockResolvedValue({ allowed: false, reason: 'no_consent' }),
    };

    const config: ResolvedConfig = {
      practiceId: 'demo',
      triage: { score_weights: { acuity: 1 } },
      priority_thresholds: { stat: 0.9, urgent: 0.7, soon: 0.4, routine: 0 },
    };

    const ctx: TriageContext = {
      id: 'task-consent-denied',
      config,
      features: { acuity: 0.75 },
      rawFeatures: { acuity: 0.75 },
      patientId: 'patient-consent',
      correlationId: 'corr-consent',
      fhirRepository,
      bus,
      consentEvaluator,
      triageInput: {
        patientId: 'patient-consent',
        narrative: 'Denied by consent policy',
        features: { acuity: 0.75 },
      },
    };

    const intake = new IntakeState();
    await intake.handle(ctx, { type: 'triage.evaluate' });
    const scored = new ScoredState();
    await scored.handle(ctx, { type: 'triage.evaluate' });

    const state = new TaskCreatedState();
    await expect(state.handle(ctx, { type: 'triage.evaluate' })).rejects.toMatchObject({ code: 'consent_denied' });
    expect(createTask).not.toHaveBeenCalled();
    expect(consentEvaluator.check).toHaveBeenCalledWith({
      patientId: 'patient-consent',
      correlationId: 'corr-consent',
      purpose: 'triage.assignment',
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, envelope] = publish.mock.calls[0] as [string, { payload?: unknown }];
    expect(topic).toBe(Topics.audit.event);
    expect((envelope?.payload as { reasonCode?: string })?.reasonCode).toBe('no_consent');
  });
});

  it('maps FHIR conflicts to conflict errors', async () => {
    const conflictError = Object.assign(new Error('conflict'), { status: 409 });
    const createTask = vi.fn().mockRejectedValue(conflictError);
    const fhirRepository: FhirRepository = {
      upsertBundle: vi.fn(),
      createTask,
      createAppointment: vi.fn(),
      createDocumentReference: vi.fn(),
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
      id: 'conflict-case',
      config,
      features: { acuity: 0.6 },
      rawFeatures: { acuity: 0.6 },
      patientId: 'patient-002',
      narrative: 'conflict scenario',
      correlationId: 'corr-conflict',
      fhirRepository,
      bus: {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
      },
      queueNotifier: { notify: vi.fn() },
      triageInput: {
        patientId: 'patient-002',
        narrative: 'conflict scenario',
        features: { acuity: 0.6 },
      },
    };

    const intake = new IntakeState();
    await intake.handle(ctx, { type: 'triage.evaluate' });
    const scored = new ScoredState();
    await scored.handle(ctx, { type: 'triage.evaluate' });

    const state = new TaskCreatedState();
    await expect(state.handle(ctx, { type: 'triage.evaluate' })).rejects.toMatchObject({ code: 'conflict' });
    const errorRecords = getCounterRecords('triage.task.create.error');
    expect(errorRecords.at(-1)?.attributes).toMatchObject({
      code: 'conflict',
      correlationId: 'corr-conflict',
      outcome: 'error',
    });
    const durationRecords = getHistogramRecords('triage.task.create.duration_ms');
    expect(durationRecords.at(-1)?.attributes?.outcome).toBe('error');
  });
