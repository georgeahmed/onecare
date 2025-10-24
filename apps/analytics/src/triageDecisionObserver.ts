import type { MessageBus, Subscription } from '@onecare/bus';
import { getBus, withMessageGuards, isGuardedBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, createEnvelope } from '@onecare/events';
import type { TriageDecision } from '@onecare/events';
import { validate, type ValidationError } from '@onecare/domain';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import { logger, ensureTracing, createCounter, createHistogram, setCorrelationId, withCorrelationContext } from '@onecare/observability';
import { createInMemoryIdempotencyStore } from './idempotencyStore';

ensureTracing('analytics-triage-decision');

const TRIAGE_DECISION_SCHEMA_ID = 'https://onecare/schemas/triage/triage-decision.json';
const TRIAGE_DECISION_ALLOWED_TOPICS = new Set<string>([
  Topics.triage.decision ?? 'triage.decision',
  Topics.broker.deadLetter,
]);

const triageDecisionCounter = createCounter('analytics.triage_decision.observed_total');
const triageDecisionDuplicateCounter = createCounter('analytics.triage_decision.duplicate_total');
const triageDecisionScoreHistogram = createHistogram('analytics.triage_decision.score');
const triageDecisionInvalidCounter = createCounter('analytics.triage_decision.invalid_total');
const triageDecisionReplaySuppressedCounter = createCounter('analytics.triage_decision.replay_suppressed_total');

export interface TriageDecisionObserverOptions {
  bus?: MessageBus;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
}

export class TriageDecisionObserver {
  private readonly bus: MessageBus;
  private subscription: Subscription | null = null;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly idempotencyTtlSeconds: number;

  constructor(options: TriageDecisionObserverOptions = {}) {
    const baseBus = options.bus ?? getBus();
    this.idempotencyStore = options.idempotencyStore ?? createInMemoryIdempotencyStore();
    const ttl = options.idempotencyTtlSeconds;
    this.idempotencyTtlSeconds =
      typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_IDEMPOTENCY_TTL_SECONDS;
    this.bus = isGuardedBus(baseBus)
      ? baseBus
      : withMessageGuards(baseBus, {
          allowedTopics: TRIAGE_DECISION_ALLOWED_TOPICS,
        });
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = await this.bus.subscribe<TypedEnvelope<TriageDecision>>(
      Topics.triage.decision ?? 'triage.decision',
      async (message) => {
        await this.handleEnvelope(message.payload);
      },
    );
    logger.info('triage decision observer subscribed', { topic: Topics.triage.decision ?? 'triage.decision' });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    await this.subscription.unsubscribe();
    this.subscription = null;
    logger.info('triage decision observer unsubscribed', { topic: Topics.triage.decision ?? 'triage.decision' });
  }

  private async handleEnvelope(envelope: TypedEnvelope<TriageDecision>): Promise<void> {
    await withCorrelationContext(async () => {
      const { correlationId } = envelope;
      if (correlationId) {
        setCorrelationId(correlationId);
      }

      const key = this.deriveIdempotencyKey(envelope);
      if (!key) {
        await this.processEnvelope(envelope);
        return;
      }

      const result = await executeWithIdempotency({
        store: this.idempotencyStore,
        key,
        ttlSeconds: this.idempotencyTtlSeconds,
        execute: async () => {
          await this.processEnvelope(envelope);
          return true;
        },
        onDuplicate: () => {
          const priority = envelope.payload?.priority ?? 'UNKNOWN';
          triageDecisionReplaySuppressedCounter.add(1, { priority });
          logger.warn('triage.decision duplicate_suppressed', {
            topic: envelope.topic,
            correlationId: envelope.correlationId,
            eventId: envelope.id,
            priority,
          });
        },
      });

      if (result.status === 'skipped') {
        return;
      }
    });
  }

  private async processEnvelope(envelope: TypedEnvelope<TriageDecision>): Promise<void> {
    const { correlationId, payload, id, topic } = envelope;
    const validation = validate(TRIAGE_DECISION_SCHEMA_ID, payload);
    if (!validation.ok) {
      triageDecisionInvalidCounter.add(1, { reason: 'validation_failed' });
      logger.warn('triage.decision payload failed validation', {
        correlationId,
        errorCount: validation.errors.length,
        errors: sanitizeValidationErrors(validation.errors),
      });
      await this.publishToDlq({
        correlationId,
        envelope,
        cause: 'validation_failed',
        details: { errors: sanitizeValidationErrors(validation.errors) },
      });
      return;
    }

    const priority = payload.priority;
    const duplicate = Boolean(payload.duplicateOf);
    const score = typeof payload.score === 'number' ? payload.score : undefined;

    triageDecisionCounter.add(1, { priority });
    if (duplicate) {
      triageDecisionDuplicateCounter.add(1, { priority });
    }
    if (typeof score === 'number') {
      triageDecisionScoreHistogram.record(score, { priority });
    }

    logger.info('triage decision observed', {
      correlationId,
      eventId: id,
      priority,
      duplicate,
      reasons: payload.reasons?.slice(0, 5),
      hasAssignment: Boolean(payload.assignment?.owner || payload.assignment?.team),
      topic,
    });
  }

  private deriveIdempotencyKey(envelope: TypedEnvelope<TriageDecision>): string | undefined {
    if (envelope.id && envelope.id.trim().length > 0) {
      return `triage:${envelope.id.trim()}`;
    }
    return undefined;
  }

  private async publishToDlq(input: {
    correlationId?: string;
    envelope: TypedEnvelope<TriageDecision>;
    cause: 'validation_failed';
    details?: Record<string, unknown>;
  }): Promise<void> {
    const { correlationId, envelope, cause, details } = input;
    const payloadRef: Record<string, unknown> = {
      cause: `triage.decision.${cause}`,
      eventId: envelope.id,
      priority: envelope.payload?.priority,
      details,
    };
    const dlqPayload: Record<string, unknown> = {
      originalTopic: envelope.topic,
      ts: new Date().toISOString(),
      attempts: 1,
      payloadRef,
      errorCode: `triage.decision.${cause}`,
      errorMessage: 'triage.decision payload failed validation',
    };
    if (correlationId) {
      dlqPayload.correlationId = correlationId;
    }
    const envelopeToPublish = createEnvelope(Topics.broker.deadLetter, dlqPayload, correlationId);
    try {
      await this.bus.publish(Topics.broker.deadLetter, envelopeToPublish, correlationId ? { 'x-correlation-id': correlationId } : undefined);
      logger.warn('triage.decision.dlq_published', {
        correlationId,
        eventId: envelope.id,
        cause,
      });
    } catch (err) {
      logger.error('triage.decision.dlq_publish_failed', {
        correlationId,
        eventId: envelope.id,
        cause,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

export async function startTriageDecisionObserver(options: TriageDecisionObserverOptions = {}): Promise<TriageDecisionObserver> {
  const observer = new TriageDecisionObserver(options);
  await observer.start();
  return observer;
}

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function sanitizeValidationErrors(errors: ValidationError[]): Array<{ path: string; keyword: string }> {
  return errors.slice(0, 5).map((err) => ({
    path: err.path,
    keyword: err.keyword,
  }));
}
