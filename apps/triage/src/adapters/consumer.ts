import { performance } from 'node:perf_hooks';
import {
  getBus,
  withMessageGuards,
  type Message,
  type MessageBus,
  type Subscription,
} from '@onecare/bus';
import type { ResolvedConfig } from '@onecare/config';
import {
  Topics,
  createEnvelope,
  type DlqEvent,
  type TriageInput,
  type TypedEnvelope,
} from '@onecare/events';
import {
  createCounter,
  createHistogram,
  ensureTracing,
  logger,
  setCorrelationId,
  withCorrelationContext,
} from '@onecare/observability';
import type { FeatureStore, FhirRepository, IdempotencyStore, QueueNotifier } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import { assertValidTriageInput } from '../application/contracts';
import type { DuplicateHandler, TriageContext } from '../application/triage.state';
import { runTriageMachine } from '../application/triage.machine';
import type { AssignmentConsentEvaluator } from '../application/triage.state';
import type { TriageSlaTracker } from '../sla/aging';

ensureTracing('triage-consumer');

const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const CORRELATION_HEADER = 'x-correlation-id';
const MESSAGE_ID_HEADER = 'x-message-id';
const RETRYABLE_ERROR_CODES = new Set([
  'upstream_unavailable',
  'upstream_timeout',
  'too_many_requests',
  'guard_timeout',
  'network_error',
]);

const consumeOkCounter = createCounter('triage.consume.ok');
const consumeErrorCounter = createCounter('triage.consume.error');
const consumeRetryCounter = createCounter('triage.consume.retry');
const consumeDlqCounter = createCounter('triage.consume.dlq');
const consumeDuplicateCounter = createCounter('triage.consume.duplicate');
const consumeDurationHistogram = createHistogram('triage.consume.duration_ms');
const triageRetryCounter = createCounter('triage.retry');
const triageDlqCounter = createCounter('triage.dlq');
const pipelineDurationHistogram = createHistogram('triage.pipeline.duration_ms');

interface ProcessContext {
  envelope: TypedEnvelope<TriageInput>;
  correlationId?: string;
  idempotencyKey: string;
  attempt: number;
  startedAt: number;
}

export interface TriageConsumerOptions {
  bus?: MessageBus;
  config: ResolvedConfig;
  fhirRepository: FhirRepository;
  queueNotifier?: QueueNotifier;
  featureStore?: FeatureStore;
  ingressIdempotencyStore?: IdempotencyStore;
  ingressIdempotencyTtlSeconds?: number;
  taskIdempotencyStore?: IdempotencyStore;
  taskIdempotencyTtlSeconds?: number;
  duplicateHandler?: DuplicateHandler;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  dlqTopic?: string;
  now?: () => number;
  slaTracker?: TriageSlaTracker;
  consentEvaluator?: AssignmentConsentEvaluator;
}

interface NormalizedOptions {
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio: number;
  ingressIdempotencyTtlSeconds: number;
  taskIdempotencyTtlSeconds: number;
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  maxAttempts: 3,
  retryBaseDelayMs: 150,
  retryMaxDelayMs: 2_000,
  retryJitterRatio: 0.2,
  ingressIdempotencyTtlSeconds: 15 * 60,
  taskIdempotencyTtlSeconds: 10 * 60,
};

export class TriageConsumer {
  private readonly baseBus: MessageBus;
  private readonly subscribeBus: MessageBus;
  private readonly config: ResolvedConfig;
  private readonly fhirRepository: FhirRepository;
  private readonly queueNotifier?: QueueNotifier;
  private readonly featureStore?: FeatureStore;
  private readonly ingressIdempotencyStore?: IdempotencyStore;
  private readonly taskIdempotencyStore?: IdempotencyStore;
  private readonly duplicateHandler?: DuplicateHandler;
  private readonly now: () => number;
  private readonly dlqTopic: string;
  private readonly normalized: NormalizedOptions;
  private readonly slaTracker?: TriageSlaTracker;
  private readonly consentEvaluator?: AssignmentConsentEvaluator;
  private subscription: Subscription | null = null;

  constructor(options: TriageConsumerOptions) {
    if (!options?.config) {
      throw new Error('triage_consumer_config_missing');
    }
    if (!options?.fhirRepository) {
      throw new Error('triage_consumer_fhir_repository_missing');
    }
    this.config = options.config;
    this.fhirRepository = options.fhirRepository;
    this.queueNotifier = options.queueNotifier;
    this.featureStore = options.featureStore;
    this.ingressIdempotencyStore = options.ingressIdempotencyStore;
    this.taskIdempotencyStore = options.taskIdempotencyStore ?? options.ingressIdempotencyStore;
    this.duplicateHandler = options.duplicateHandler;
    this.now = options.now ?? (() => Date.now());
    this.dlqTopic = options.dlqTopic ?? Topics.broker.deadLetter;
    this.slaTracker = options.slaTracker;
    this.consentEvaluator = options.consentEvaluator;
    this.baseBus = options.bus ?? getBus();
    this.subscribeBus = withMessageGuards(this.baseBus, {
      allowedTopics: [Topics.triage.input],
    });
    this.normalized = normalizeOptions(options);
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = await this.subscribeBus.subscribe<TypedEnvelope<TriageInput>>(Topics.triage.input, async (msg) =>
      this.handleMessage(msg),
    );
    logger.info('triage.consumer.started', {
      component: 'triage',
      topic: Topics.triage.input,
      maxAttempts: this.normalized.maxAttempts,
      dlqTopic: this.dlqTopic,
    });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    await this.subscription.unsubscribe();
    this.subscription = null;
    logger.info('triage.consumer.stopped', { component: 'triage', topic: Topics.triage.input });
  }

  private async handleMessage(message: Message<TypedEnvelope<TriageInput>>): Promise<void> {
    const envelope = message.payload;
    if (!isTypedEnvelope(envelope)) {
      logger.error('triage.consumer.invalid_envelope', {
        component: 'triage',
        topic: message.topic,
        hasPayload: Boolean(envelope),
      });
      return;
    }

    const correlationId = normalizeCorrelationId(
      envelope.correlationId ?? getHeaderValue(message.headers, CORRELATION_HEADER),
    );
    const idempotencyKey = this.deriveIdempotencyKey(message, envelope);
    const startedAt = this.now();
    const processCtx: ProcessContext = {
      envelope,
      correlationId,
      idempotencyKey,
      attempt: 0,
      startedAt,
    };

    while (processCtx.attempt < this.normalized.maxAttempts) {
      processCtx.attempt += 1;
      try {
        const result = await this.processAttempt(message, processCtx);
        consumeOkCounter.add(1, {
          topic: message.topic,
          attempt: processCtx.attempt,
          outcome: result,
        });
        consumeDurationHistogram.record(this.now() - startedAt, {
          topic: message.topic,
          outcome: result,
        });
        return;
      } catch (error) {
        const code = extractErrorCode(error);
        const retryable = this.isRetryable(error);
        consumeErrorCounter.add(1, {
          topic: message.topic,
          attempt: processCtx.attempt,
          retryable: String(retryable),
          code: code ?? 'unknown',
        });
        if (retryable && processCtx.attempt < this.normalized.maxAttempts) {
          consumeRetryCounter.add(1, {
            topic: message.topic,
            attempt: processCtx.attempt,
            code: code ?? 'unknown',
          });
          triageRetryCounter.add(1, {
            topic: message.topic,
            code: code ?? 'unknown',
          });
          await this.delay(processCtx.attempt);
          continue;
        }

        consumeDlqCounter.add(1, {
          topic: message.topic,
          code: code ?? 'unknown',
        });
        triageDlqCounter.add(1, {
          topic: message.topic,
          code: code ?? 'unknown',
        });
        await this.publishDlq(processCtx, error);
        return;
      }
    }
  }

  private async processAttempt(
    message: Message<TypedEnvelope<TriageInput>>,
    ctx: ProcessContext,
  ): Promise<'processed' | 'duplicate'> {
    const execute = async () => {
      const pipelineStart = performance.now();
      let triageContext: TriageContext | undefined;
      let finalState: string | undefined;
      await withCorrelationContext(async () => {
        if (ctx.correlationId) {
          setCorrelationId(ctx.correlationId);
        }
        assertValidTriageInput(ctx.envelope.payload);
        triageContext = this.buildTriageContext(ctx);
        const result = await runTriageMachine(triageContext);
        finalState = result.state;
      });
      if (triageContext) {
        const duration = performance.now() - pipelineStart;
        pipelineDurationHistogram.record(duration, {
          outcome: triageContext.isDuplicate ? 'duplicate' : 'processed',
          priority: triageContext.priority ?? triageContext.decision?.priority ?? 'unset',
          fallback: triageContext.fallbackApplied ? 'true' : 'false',
          state: finalState ?? 'unknown',
        });
      }
      return 'processed' as const;
    };

    if (!this.ingressIdempotencyStore) {
      return execute();
    }

    let duplicateDetected = false;
    const result = await executeWithIdempotency({
      store: this.ingressIdempotencyStore,
      key: ctx.idempotencyKey,
      ttlSeconds: this.normalized.ingressIdempotencyTtlSeconds,
      execute,
      onDuplicate: () => {
        duplicateDetected = true;
      },
    });

    if (duplicateDetected || result.status === 'skipped') {
      this.recordDuplicate(ctx);
      return 'duplicate';
    }

    return 'processed';
  }

  private buildTriageContext(ctx: ProcessContext): TriageContext {
    const payload = ctx.envelope.payload;
    const rawFeatures = isRecord(payload.features) ? { ...payload.features } : undefined;

    return {
      id: ctx.envelope.id,
      config: this.config,
      triageInput: payload,
      features: {},
      patientId: payload.patientId,
      narrative: payload.narrative,
      rawFeatures,
      correlationId: ctx.correlationId,
      now: this.now(),
      bus: this.baseBus,
      fhirRepository: this.fhirRepository,
      queueNotifier: this.queueNotifier,
      featureStore: this.featureStore,
      handleDuplicate: this.duplicateHandler,
      idempotencyStore: this.taskIdempotencyStore,
      idempotencyKey: ctx.idempotencyKey,
      idempotencyTtlSeconds: this.normalized.taskIdempotencyTtlSeconds,
      slaTracker: this.slaTracker,
      consentEvaluator: this.consentEvaluator,
    };
  }

  private deriveIdempotencyKey(
    message: Message<TypedEnvelope<TriageInput>>,
    envelope: TypedEnvelope<TriageInput>,
  ): string {
    const fromHeader = normalizeHeaderValue(getHeaderValue(message.headers, IDEMPOTENCY_HEADER));
    if (fromHeader) return fromHeader;
    const fromEnvelope = normalizeHeaderValue(getHeaderValue(message.headers, MESSAGE_ID_HEADER));
    if (fromEnvelope) return fromEnvelope;
    if (typeof envelope.id === 'string' && envelope.id.trim().length > 0) {
      return envelope.id.trim();
    }
    return `triage:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }

  private recordDuplicate(ctx: ProcessContext): void {
    consumeDuplicateCounter.add(1, {
      topic: Topics.triage.input,
      attempt: ctx.attempt,
    });
    logger.info('triage.consumer.duplicate', {
      component: 'triage',
      idempotencyKey: ctx.idempotencyKey,
      correlationId: ctx.correlationId,
    });
  }

  private async delay(attempt: number): Promise<void> {
    const exponential = this.normalized.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
    const jitterMax = Math.max(0, Math.floor(exponential * this.normalized.retryJitterRatio));
    const jitter = jitterMax > 0 ? Math.floor(Math.random() * jitterMax) : 0;
    const delayMs = Math.min(exponential + jitter, this.normalized.retryMaxDelayMs);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private async publishDlq(ctx: ProcessContext, error: unknown): Promise<void> {
    const payload: DlqEvent = {
      originalTopic: Topics.triage.input,
      correlationId: ctx.correlationId,
      errorCode: extractErrorCode(error),
      errorMessage: buildSafeErrorMessage(error),
      attempts: ctx.attempt,
      payloadRef: {
        envelopeId: ctx.envelope.id,
        idempotencyKey: ctx.idempotencyKey,
        timestamp: ctx.envelope.timestamp,
      },
      ts: new Date().toISOString(),
    };

    try {
      const dlqEnvelope = createEnvelope(this.dlqTopic, payload, ctx.correlationId);
      const headers: Record<string, string> = {
        [MESSAGE_ID_HEADER]: dlqEnvelope.id,
        [IDEMPOTENCY_HEADER]: `${Topics.triage.input}:${ctx.idempotencyKey}`,
      };
      if (ctx.correlationId) {
        headers[CORRELATION_HEADER] = ctx.correlationId;
      }
      await this.baseBus.publish(this.dlqTopic, dlqEnvelope, headers);
    } catch (publishError) {
      logger.error('triage.consumer.dlq_failed', {
        component: 'triage',
        correlationId: ctx.correlationId,
        reason: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error && typeof error === 'object') {
      if ((error as { retryable?: boolean }).retryable === true) {
        return true;
      }
    }
    const code = extractErrorCode(error);
    if (!code) return false;
    return RETRYABLE_ERROR_CODES.has(code);
  }
}

function normalizeOptions(options: TriageConsumerOptions): NormalizedOptions {
  const normalized: NormalizedOptions = { ...DEFAULT_OPTIONS };
  if (Number.isFinite(options.retryAttempts) && options.retryAttempts) {
    const attempts = Math.max(1, Math.floor(options.retryAttempts));
    normalized.maxAttempts = attempts;
  }
  if (Number.isFinite(options.retryBaseDelayMs) && options.retryBaseDelayMs) {
    normalized.retryBaseDelayMs = Math.max(10, Math.floor(options.retryBaseDelayMs));
  }
  if (Number.isFinite(options.retryMaxDelayMs) && options.retryMaxDelayMs) {
    normalized.retryMaxDelayMs = Math.max(normalized.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs));
  }
  if (Number.isFinite(options.retryJitterRatio) && options.retryJitterRatio !== undefined) {
    const ratio = Number(options.retryJitterRatio);
    if (!Number.isNaN(ratio)) {
      normalized.retryJitterRatio = Math.min(1, Math.max(0, ratio));
    }
  }
  if (Number.isFinite(options.ingressIdempotencyTtlSeconds) && options.ingressIdempotencyTtlSeconds) {
    normalized.ingressIdempotencyTtlSeconds = normalizeTtlSeconds(options.ingressIdempotencyTtlSeconds);
  }
  if (Number.isFinite(options.taskIdempotencyTtlSeconds) && options.taskIdempotencyTtlSeconds) {
    normalized.taskIdempotencyTtlSeconds = normalizeTtlSeconds(options.taskIdempotencyTtlSeconds);
  }
  return normalized;
}

function normalizeTtlSeconds(value: number): number {
  const parsed = Math.floor(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_OPTIONS.ingressIdempotencyTtlSeconds;
  }
  return Math.min(24 * 60 * 60, Math.max(30, parsed));
}

function isTypedEnvelope(candidate: unknown): candidate is TypedEnvelope<TriageInput> {
  if (!candidate || typeof candidate !== 'object') return false;
  const env = candidate as { topic?: unknown; payload?: unknown; id?: unknown; timestamp?: unknown };
  return typeof env.topic === 'string' && typeof env.id === 'string' && !!env.payload && typeof env.timestamp === 'string';
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate);
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHeaderValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getHeaderValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const withCode = error as { code?: unknown; name?: unknown };
    const code = typeof withCode.code === 'string' ? withCode.code : undefined;
    if (code && code.trim().length > 0) return code.trim();
    const name = typeof withCode.name === 'string' ? withCode.name : undefined;
    if (name && name.trim().length > 0) return name.trim();
  }
  return undefined;
}

function buildSafeErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') {
    return error.slice(0, 120);
  }
  if (error instanceof Error) {
    return error.message.slice(0, 120);
  }
  return undefined;
}
