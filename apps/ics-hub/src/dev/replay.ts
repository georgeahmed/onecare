import { createHash } from 'node:crypto';
import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import { logger } from '@onecare/observability';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import { publishWithGuard, type PublishOptions } from '../adapters/bus.adapter';

export interface DLQEnvelope<T = unknown> {
  originalTopic: string;
  payload: T;
  correlationId?: string;
  error?: string;
  ts: string;
}

// Minimal replay helper to republish DLQ entries.
export interface ReplayOptions {
  idempotencyStore?: IdempotencyStore | null;
  ttlSeconds?: number;
  publish?: PublishOptions;
}

export async function replayDlqMessage<T>(
  bus: MessageBus,
  dlq: DLQEnvelope<T>,
  options: ReplayOptions = {},
): Promise<void> {
  const replayCorrelation = dlq.correlationId ? `${dlq.correlationId}:replay` : undefined;
  const envelope = createEnvelope(dlq.originalTopic, dlq.payload as T, replayCorrelation);
  const headers: Record<string, string> = {
    'x-original-topic': dlq.originalTopic,
  };
  if (replayCorrelation) {
    headers['x-correlation-id'] = replayCorrelation;
  }
  const publish = async () => {
    await publishWithGuard(
      bus,
      envelope.topic,
      envelope,
      replayCorrelation,
      {
        timeoutMs: 500,
        maxRetries: 1,
        baseDelayMs: 10,
        ...options.publish,
      },
      headers,
    );
  };

  const key = buildReplayKey(dlq);
  const ttlSeconds = Math.max(10, Math.floor(options.ttlSeconds ?? 10 * 60));

  if (options.idempotencyStore) {
    const { status } = await executeWithIdempotency({
      store: options.idempotencyStore,
      key,
      ttlSeconds,
      execute: async () => {
        logger.info('ics.dlq.replay_attempt', {
          originalTopic: dlq.originalTopic,
          correlationId: dlq.correlationId,
        });
        await publish();
        return true;
      },
      onDuplicate: () => {
        logger.warn('ics.dlq.replay_duplicate', {
          originalTopic: dlq.originalTopic,
          correlationId: dlq.correlationId,
        });
      },
      onError: (error) => {
        logger.error('ics.dlq.replay_failed', {
          originalTopic: dlq.originalTopic,
          correlationId: dlq.correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    });
    if (status === 'skipped') {
      return;
    }
    return;
  }

  logger.info('ics.dlq.replay_attempt', {
    originalTopic: dlq.originalTopic,
    correlationId: dlq.correlationId,
  });
  await publish();
}

// Example usage (dev): replay one DLQ message
export async function exampleReplay(bus: MessageBus) {
  const sample: DLQEnvelope = {
    originalTopic: Topics.ics?.referralRequest ?? 'ics.referral.request',
    payload: { requestId: 'demo', serviceCode: '1111' },
    correlationId: 'dlq-demo',
    ts: new Date().toISOString(),
  };
  await replayDlqMessage(bus, sample);
}

function buildReplayKey(dlq: DLQEnvelope<unknown>): string {
  const correlation = dlq.correlationId ?? 'none';
  const digest = hashPayload(dlq.payload);
  return `ics:dlq:replay:${dlq.originalTopic}:${correlation}:${digest}`;
}

function hashPayload(payload: unknown): string {
  try {
    const json = JSON.stringify(payload ?? null);
    return createHash('sha1').update(json).digest('hex');
  } catch {
    return 'unknown';
  }
}
