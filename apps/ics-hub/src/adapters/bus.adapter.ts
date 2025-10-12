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
  const timeoutMs = opts.timeoutMs ?? 500;
  const maxRetries = opts.maxRetries ?? 0;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      await publishWithTimeout(bus, topic, payload, headers, timeoutMs);
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
    correlationId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    ts: new Date().toISOString(),
  };
  await bus.publish(Topics.broker.deadLetter, dlqPayload, headers);
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
