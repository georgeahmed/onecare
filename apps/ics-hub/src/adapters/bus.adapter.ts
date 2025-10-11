import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';

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

export async function publishWithGuard<T>(
  bus: MessageBus,
  topic: string,
  payload: T,
  correlationId?: string,
  opts: PublishOptions = { timeoutMs: 500, maxRetries: 2, baseDelayMs: 10 }
): Promise<void> {
  const headers: Record<string, string> = {};
  if (correlationId) headers['x-correlation-id'] = correlationId;
  let lastErr: unknown;
  const base = opts.baseDelayMs ?? 10;
  for (let i = 0; i <= (opts.maxRetries ?? 0); i++) {
    try {
      await bus.publish(topic, payload, headers);
      return;
    } catch (err) {
      lastErr = err;
      if (i === (opts.maxRetries ?? 0)) break;
      const exp = Math.min(5, i + 1);
      const jitter = Math.random() * base;
      await new Promise(r => setTimeout(r, exp * base + jitter));
    }
  }
  // Fallback to DLQ
  const dlqPayload: DLQMessage<T> = {
    originalTopic: topic,
    payload,
    correlationId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    ts: new Date().toISOString(),
  };
  await bus.publish(Topics.broker.deadLetter, dlqPayload, headers);
}

