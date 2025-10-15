import { getBus, withMessageGuards, type MessageBus, type Subscription } from '@onecare/bus';
import {
  Topics,
  createEnvelope,
  type PharmacyOutcome,
  type PharmacyReferral,
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
import { ContractValidationError, assertValidPharmacyOutcome } from './contracts';
import { buildReferralRequest, validatePharmacyReferralIngress } from './referralIngress';
import { CpcsClientError } from './cpcs.client';
import type { PharmacyRouterResult } from '../application/router';
import type { PharmacyReferralRequest } from '../index';

ensureTracing('pharmacy-router-consumer');

const referralReceivedCounter = createCounter('pharmacy.router.ingress_total');
const referralSuccessCounter = createCounter('pharmacy.router.process_success_total');
const referralFailureCounter = createCounter('pharmacy.router.process_failure_total');
const referralRetryCounter = createCounter('pharmacy.router.retry_total');
const referralDlqCounter = createCounter('pharmacy.router.dlq_total');
const referralLagHistogram = createHistogram('pharmacy.router.ingest_lag_ms');
const referralDurationHistogram = createHistogram('pharmacy.router.process_duration_ms');
const outcomePublishedCounter = createCounter('pharmacy.router.outcome_published_total');
const outcomePublishFailureCounter = createCounter('pharmacy.router.outcome_publish_failed_total');

export interface PharmacyRouterConsumerOptions {
  bus?: MessageBus;
  processor: (request: PharmacyReferralRequest) => Promise<PharmacyRouterResult>;
  deadLetterTopic?: string;
  outcomeTopic?: string;
  maxConcurrency?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
}

interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

interface ProcessingStats {
  processed: number;
  failed: number;
  retried: number;
  dlq: number;
  outcomePublished: number;
  outcomePublishFailed: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  jitterRatio: 0.2,
};

export class PharmacyRouterConsumer {
  private readonly bus: MessageBus;
  private subscription: Subscription | null = null;
  private readonly semaphore: Semaphore;
  private readonly retryPolicy: RetryPolicy;
  private readonly deadLetterTopic: string;
  private readonly outcomeTopic: string;
  private readonly stats: ProcessingStats = {
    processed: 0,
    failed: 0,
    retried: 0,
    dlq: 0,
    outcomePublished: 0,
    outcomePublishFailed: 0,
  };
  private stopped = false;

  constructor(private readonly options: PharmacyRouterConsumerOptions) {
    if (typeof options.processor !== 'function') {
      throw new Error('pharmacy_router_processor_missing');
    }
    const baseBus = options.bus ?? getBus();
    this.deadLetterTopic = options.deadLetterTopic ?? Topics.broker.deadLetter;
    this.outcomeTopic = options.outcomeTopic ?? Topics.pharmacy.outcome;
    this.bus = withMessageGuards(baseBus, {
      allowedTopics: [Topics.pharmacy.referral, this.deadLetterTopic, this.outcomeTopic],
    });
    this.semaphore = new Semaphore(Math.max(1, Math.floor(options.maxConcurrency ?? 5)));
    this.retryPolicy = normalizeRetryPolicy(options);
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.stopped = false;
    this.subscription = await this.bus.subscribe(Topics.pharmacy.referral, async ({ payload }) => {
      await this.handleMessage(payload);
    });
    logger.info('pharmacy.router.consumer.started', {
      outcomeTopic: this.outcomeTopic,
      deadLetterTopic: this.deadLetterTopic,
      maxConcurrency: this.semaphore.capacity,
      maxAttempts: this.retryPolicy.maxAttempts,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    await this.semaphore.waitForIdle();
    logger.info('pharmacy.router.consumer.stopped', {
      processed: this.stats.processed,
      failed: this.stats.failed,
      dlq: this.stats.dlq,
    });
  }

  getDiagnostics(): ProcessingStats & { inflight: number; queue: number } {
    return {
      ...this.stats,
      inflight: this.semaphore.inflight,
      queue: this.semaphore.queueSize,
    };
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      if (this.stopped) return;
      referralReceivedCounter.add(1);
      const validation = validatePharmacyReferralIngress(raw);
      if (!validation.ok) {
        this.stats.failed += 1;
        referralFailureCounter.add(1, { reason: validation.reason });
        await this.publishDlq(validation.correlationId, validation.reason, 'pharmacy_referral_validation_failed', {
          reason: validation.reason,
          errors: validation.errors.slice(0, 5),
        });
        return;
      }

      const { envelope } = validation;
      const lag = computeLagMs(envelope.timestamp);
      if (lag !== null) {
        referralLagHistogram.record(lag);
      }
      await this.processWithRetry(envelope);
    } catch (error) {
      logger.error('pharmacy.router.consumer.unhandled_error', {
        error: serializeError(error),
      });
    } finally {
      release();
    }
  }

  private async processWithRetry(envelope: TypedEnvelope<PharmacyReferral>): Promise<void> {
    const correlationId = envelope.correlationId;
    const request = buildReferralRequest(envelope);
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const attemptLabel = attempt;
      try {
        await withCorrelationContext(async () => {
          if (correlationId) {
            setCorrelationId(correlationId);
          }
          const startedAt = Date.now();
          try {
            const result = await this.options.processor(request);
            this.stats.processed += 1;
            referralSuccessCounter.add(1, { state: result.state });
            referralDurationHistogram.record(Date.now() - startedAt, { outcome: 'success', state: result.state });
            await this.publishOutcome(result.context.outcomePayload, correlationId, result.context.referralPayload);
            return;
          } catch (error) {
            referralDurationHistogram.record(Date.now() - startedAt, { outcome: 'failure' });
            throw error;
          }
        });
        return;
      } catch (error) {
        const retryable = isRetryableError(error);
        this.stats.failed += 1;
        referralFailureCounter.add(1, {
          reason: retryable ? 'retryable_error' : 'non_retryable_error',
        });
        logger.warn('pharmacy.router.processing_failed', {
          attempt: attemptLabel,
          correlationId,
          retryable,
          error: serializeError(error),
        });
        if (!retryable) {
          await this.publishDlq(correlationId, 'processing_failed', error instanceof Error ? error.message : 'unknown_error', {
            envelopeId: envelope.id,
            organisationId: request.organisationId,
            state: 'aborted',
          });
          return;
        }
        if (attempt >= this.retryPolicy.maxAttempts) {
          await this.publishDlq(correlationId, 'processing_exhausted', error instanceof Error ? error.message : 'unknown_error', {
            envelopeId: envelope.id,
            organisationId: request.organisationId,
            attempts: attemptLabel,
          });
          return;
        }
        this.stats.retried += 1;
        referralRetryCounter.add(1, { attempt: String(attemptLabel) });
        await delayMs(calculateDelay(this.retryPolicy, attempt + 1));
      }
    }
  }

  private async publishOutcome(
    payload: PharmacyOutcome | undefined,
    correlationId: string | undefined,
    referralPayload?: PharmacyReferral,
  ): Promise<void> {
    if (!payload) {
      logger.warn('pharmacy.router.outcome_missing', {
        correlationId,
        organisationId: referralPayload?.pharmacyOrg,
      });
      return;
    }
    try {
      assertValidPharmacyOutcome(payload);
      const envelope = createEnvelope(this.outcomeTopic, payload, correlationId);
      await this.bus.publish(this.outcomeTopic, envelope);
      this.stats.outcomePublished += 1;
      outcomePublishedCounter.add(1, {
        status: payload.status,
      });
    } catch (error) {
      this.stats.outcomePublishFailed += 1;
      outcomePublishFailureCounter.add(1, {});
      logger.error('pharmacy.router.outcome_publish_failed', {
        correlationId,
        organisationId: referralPayload?.pharmacyOrg,
        error: serializeError(error),
      });
      throw error;
    }
  }

  private async publishDlq(
    correlationId: string | undefined,
    errorCode: string,
    errorMessage: string,
    payloadRef: Record<string, unknown>,
  ): Promise<void> {
    const dlqPayload = {
      originalTopic: Topics.pharmacy.referral,
      correlationId,
      errorCode,
      errorMessage,
      payloadRef,
      ts: new Date().toISOString(),
    };
    const envelope = createEnvelope(this.deadLetterTopic, dlqPayload, correlationId);
    await this.bus.publish(this.deadLetterTopic, envelope);
    this.stats.dlq += 1;
    referralDlqCounter.add(1, { errorCode });
  }
}

class Semaphore {
  private readonly waiting: Array<() => void> = [];
  private readonly idleResolvers: Array<() => void> = [];
  private _inflight = 0;

  constructor(public readonly capacity: number) {}

  get inflight(): number {
    return this._inflight;
  }

  get queueSize(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.capacity <= 0) {
      this._inflight += 1;
      return () => this.release();
    }
    if (this._inflight < this.capacity) {
      this._inflight += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this._inflight += 1;
        resolve(() => this.release());
      });
    });
  }

  async waitForIdle(): Promise<void> {
    if (this._inflight === 0 && this.waiting.length === 0) {
      return;
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private release(): void {
    this._inflight = Math.max(0, this._inflight - 1);
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    if (this._inflight === 0) {
      while (this.idleResolvers.length > 0) {
        const resolver = this.idleResolvers.shift();
        if (resolver) resolver();
      }
    }
  }
}

function normalizeRetryPolicy(options: PharmacyRouterConsumerOptions): RetryPolicy {
  const base = options.retryBaseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  const max = options.retryMaxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs;
  const jitter = options.retryJitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio;
  const attempts = options.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
  return {
    baseDelayMs: Math.max(50, Math.floor(base)),
    maxDelayMs: Math.max(50, Math.floor(max)),
    jitterRatio: Math.min(1, Math.max(0, jitter)),
    maxAttempts: Math.max(1, Math.floor(attempts)),
  };
}

function calculateDelay(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = policy.baseDelayMs * Math.pow(2, exponent);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * Math.random();
  return Math.floor(capped + jitter);
}

function computeLagMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Date.now() - parsed);
}

function delayMs(duration: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ContractValidationError) return false;
  if (error instanceof CpcsClientError) {
    return (
      error.code === 'upstream_timeout' ||
      error.code === 'upstream_unavailable' ||
      error.code === 'internal_error' ||
      error.code === 'unknown'
    );
  }
  return true;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!error) return { message: 'unknown_error' };
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  return { message: 'error', value: error };
}
