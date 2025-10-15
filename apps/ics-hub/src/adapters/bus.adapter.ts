import { withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope, type AuditEvent } from '@onecare/events';
import type { AutomationTaskCreation } from '../application/automation.rules';

export interface PublishOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface DLQMessage<T = unknown> {
  originalTopic: string;
  payload: T;
  correlationId?: string;
  error?: string;
  ts: string; // ISO
}

const ICS_ALLOWED_TOPICS = new Set<string>([
  Topics.ics.referralAck,
  Topics.tasks.created,
  Topics.audit.event,
  Topics.broker.deadLetter,
]);

export async function publishWithGuard<T>(
  bus: MessageBus,
  topic: string,
  payload: T,
  correlationId?: string,
  opts: PublishOptions = { timeoutMs: 500, maxRetries: 2, baseDelayMs: 10 }
): Promise<void> {
  const guardedBus = ensureIcsBus(bus);
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const headers: Record<string, string> = {};
  if (normalizedCorrelationId) headers['x-correlation-id'] = normalizedCorrelationId;
  ensureEnvelopeTopic(topic, payload);
  let lastErr: unknown;
  const base = opts.baseDelayMs ?? 10;
  const timeoutMs = opts.timeoutMs ?? 500;
  const maxRetries = opts.maxRetries ?? 0;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      await publishWithTimeout(guardedBus, topic, payload, headers, timeoutMs);
      return;
    } catch (err) {
      lastErr = err;
      if (i === maxRetries) break;
      const exp = Math.min(5, i + 1);
      const jitter = Math.random() * base;
      await new Promise((resolve) => setTimeout(resolve, exp * base + jitter));
    }
  }
  // Fallback to DLQ
  const dlqPayload: DLQMessage<T> = {
    originalTopic: topic,
    payload,
    correlationId: normalizedCorrelationId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    ts: new Date().toISOString(),
  };
  const dlqEnvelope = createEnvelope(Topics.broker.deadLetter, dlqPayload, normalizedCorrelationId);
  const dlqHeaders: Record<string, string> = {
    ...(headers ?? {}),
    'x-original-topic': topic,
  };
  await guardedBus.publish(dlqEnvelope.topic, dlqEnvelope, dlqHeaders);
}

async function publishWithTimeout<T>(
  bus: MessageBus,
  topic: string,
  payload: T,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    await bus.publish(topic, payload, headers);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bus.publish(topic, payload, headers),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('publish_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ensureEnvelopeTopic(topic: string, payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`publish_topic_missing: expected envelope for ${topic}`);
  }
  const candidate = payload as { topic?: unknown };
  if (typeof candidate.topic !== 'string' || candidate.topic.length === 0) {
    throw new Error(`publish_topic_missing: expected envelope topic for ${topic}`);
  }
  if (candidate.topic !== topic) {
    throw new Error(`publish_topic_mismatch: expected=${topic} actual=${candidate.topic}`);
  }
}

export interface AutomationPublishOptions {
  taskPublish?: PublishOptions;
  auditPublish?: PublishOptions;
  auditEventType?: string;
  now?: () => string;
}

export async function publishAutomationTasks(
  bus: MessageBus,
  creations: readonly AutomationTaskCreation[] | undefined,
  options: AutomationPublishOptions = {},
): Promise<void> {
  if (!Array.isArray(creations) || creations.length === 0) {
    return;
  }
  const now = options.now ?? (() => new Date().toISOString());
  const auditType = options.auditEventType ?? 'automation.task.created';

  for (const creation of creations) {
    const correlationId = normalizeCorrelationId(creation.correlationId);
    const taskEnvelope = createEnvelope(Topics.tasks.created, creation.task, correlationId);
    await publishWithGuard(bus, taskEnvelope.topic, taskEnvelope, correlationId, options.taskPublish);

    const audit: AuditEvent = {
      type: auditType,
      timestamp: creation.triggeredAt ?? now(),
      correlationId: correlationId ?? null,
      details: {
        ruleName: creation.ruleName,
        reason: creation.reason,
        category: creation.category,
        sourceTaskId: creation.sourceTaskId,
        taskId: creation.task.taskId,
        patientId: creation.task.patientId,
        triggeredAt: creation.triggeredAt,
      },
    };
    const auditEnvelope = createEnvelope(Topics.audit.event, audit, correlationId);
    await publishWithGuard(bus, auditEnvelope.topic, auditEnvelope, correlationId, options.auditPublish);
  }
}

function ensureIcsBus(bus: MessageBus): MessageBus {
  return withMessageGuards(bus, { allowedTopics: ICS_ALLOWED_TOPICS });
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
