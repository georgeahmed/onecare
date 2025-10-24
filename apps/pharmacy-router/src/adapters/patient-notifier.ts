import { withMessageGuards, type MessageBus } from '@onecare/bus';
import { Topics, createEnvelope, type PharmacyNotification } from '@onecare/events';
import { createCounter, createHistogram, logger } from '@onecare/observability';
import { assertValidPharmacyNotification } from './contracts';
import type { PatientNotification, PatientNotifier } from '../application/pharmacy.state';

const notificationSentCounter = createCounter('pharmacy.notification.sent_total');
const notificationSkippedCounter = createCounter('pharmacy.notification.skipped_total');
const notificationFailureCounter = createCounter('pharmacy.notification.failed_total');
const notificationRetryCounter = createCounter('pharmacy.notification.retry_total');
const notificationRetryDelayHistogram = createHistogram('pharmacy.notification.retry_delay_ms');

export type ConsentEvaluator = (details: PatientNotification) => Promise<boolean>;

export interface PatientNotificationAdapterOptions {
  bus: MessageBus;
  topic?: string;
  consentEvaluator?: ConsentEvaluator;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  jitterRatio: 0.2,
};

export class PatientNotificationAdapter implements PatientNotifier {
  private readonly bus: MessageBus;
  private readonly topic: string;
  private readonly consentEvaluator?: ConsentEvaluator;
  private readonly retryPolicy: RetryPolicy;

  constructor(options: PatientNotificationAdapterOptions) {
    if (!options.bus) {
      throw new Error('pharmacy_notification_bus_missing');
    }
    this.topic = options.topic ?? Topics.pharmacy.notification;
    this.consentEvaluator = options.consentEvaluator;
    this.retryPolicy = normalizeRetryPolicy(options);
    this.bus = withMessageGuards(options.bus, {
      allowedTopics: [this.topic],
      enforceEnvelope: true,
      requireCorrelationHeader: false,
    });
  }

  async notifyReferral(details: PatientNotification): Promise<void> {
    const summary = sanitizeSummary(details.summary);
    if (!summary) {
      notificationSkippedCounter.add(1, { reason: 'summary_missing' });
      logger.warn('pharmacy.notification.skipped', {
        reason: 'summary_missing',
        serviceRequestId: maskIdentifier(details.serviceRequestId),
      });
      return;
    }

    if (this.consentEvaluator) {
      const hasConsent = await this.consentEvaluator(details);
      if (!hasConsent) {
        notificationSkippedCounter.add(1, { reason: 'consent_denied' });
        logger.info('pharmacy.notification.skipped', {
          reason: 'consent_denied',
          serviceRequestId: maskIdentifier(details.serviceRequestId),
          correlationId: details.correlationId,
        });
        return;
      }
    }

    const payload: PharmacyNotification = buildNotificationPayload(details, summary);
    assertValidPharmacyNotification(payload);

    const envelope = createEnvelope(this.topic, payload, details.correlationId);
    const headers: Record<string, string> | undefined = buildHeaders(details.idempotencyKey);

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      try {
        await this.bus.publish(this.topic, envelope, headers);
        notificationSentCounter.add(1, { status: payload.status });
        logger.info('pharmacy.notification.published', {
          topic: this.topic,
          correlationId: details.correlationId,
          status: payload.status,
          idempotencyKey: details.idempotencyKey,
        });
        return;
      } catch (error) {
        const attemptLabel = attempt;
        const finalAttempt = attempt >= this.retryPolicy.maxAttempts;
        if (finalAttempt) {
          notificationFailureCounter.add(1, { status: payload.status });
          logger.error('pharmacy.notification.failed', {
            topic: this.topic,
            correlationId: details.correlationId,
            status: payload.status,
            attempt: attemptLabel,
            error: serializeError(error),
          });
          throw error instanceof Error ? error : new Error('pharmacy_notification_failed');
        }

        const delay = calculateDelay(this.retryPolicy, attempt + 1);
        notificationRetryCounter.add(1, { attempt: String(attemptLabel) });
        notificationRetryDelayHistogram.record(delay, { attempt: attemptLabel });
        logger.warn('pharmacy.notification.retry', {
          topic: this.topic,
          correlationId: details.correlationId,
          status: payload.status,
          attempt: attemptLabel,
          delayMs: delay,
          error: serializeError(error),
        });
        await delayMs(delay);
      }
    }
  }
}

function buildNotificationPayload(details: PatientNotification, summary: string): PharmacyNotification {
  const status = normalizeStatus(details.status);
  const payload: PharmacyNotification = {
    serviceRequestId: details.serviceRequestId,
    organisationId: details.organisationId,
    status,
    summary,
    recordedAt: new Date().toISOString(),
    channel: details.channel ?? 'unknown',
  };

  const metadata = sanitizeMetadata(details.metadata);
  if (metadata) {
    payload.metadata = metadata;
  }

  return payload;
}

function sanitizeMetadata(
  metadata: PatientNotification['metadata'],
): PharmacyNotification['metadata'] | undefined {
  if (!metadata) return undefined;
  const template = typeof metadata.template === 'string' ? metadata.template.trim() : undefined;
  const locale = typeof metadata.locale === 'string' ? metadata.locale.trim() : undefined;
  if (!template && !locale) return undefined;
  return {
    ...(template ? { template: truncate(template, 64) } : {}),
    ...(locale ? { locale: truncate(locale, 5) } : {}),
  };
}

function normalizeStatus(status: string | undefined): 'accepted' | 'queued' | 'rejected' {
  if (status === 'accepted' || status === 'queued' || status === 'rejected') {
    return status;
  }
  return 'queued';
}

function sanitizeSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const collapsed = summary.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return truncate(collapsed, 280);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function buildHeaders(idempotencyKey: string | undefined): Record<string, string> | undefined {
  if (!idempotencyKey) return undefined;
  return {
    'x-idempotency-key': idempotencyKey,
  };
}

function normalizeRetryPolicy(options: PatientNotificationAdapterOptions): RetryPolicy {
  const attempts = options.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
  const base = options.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  const max = options.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs;
  const jitter = options.jitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio;
  return {
    maxAttempts: Math.max(1, Math.floor(attempts)),
    baseDelayMs: Math.max(25, Math.floor(base)),
    maxDelayMs: Math.max(25, Math.floor(max)),
    jitterRatio: Math.min(1, Math.max(0, jitter)),
  };
}

function calculateDelay(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = policy.baseDelayMs * Math.pow(2, exponent);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = policy.jitterRatio > 0 ? capped * policy.jitterRatio * Math.random() : 0;
  return Math.max(1, Math.round(capped + jitter));
}

function delayMs(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function maskIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 4) return '*'.repeat(value.length);
  const suffix = value.slice(-4);
  return `${'*'.repeat(Math.max(0, value.length - 4))}${suffix}`;
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
