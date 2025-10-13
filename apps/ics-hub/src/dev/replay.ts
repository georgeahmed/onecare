import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';

export interface DLQEnvelope<T = unknown> {
  originalTopic: string;
  payload: T;
  correlationId?: string;
  error?: string;
  ts: string;
}

// Minimal replay helper to republish DLQ entries.
export async function replayDlqMessage<T>(bus: MessageBus, dlq: DLQEnvelope<T>): Promise<void> {
  const replayCorrelation = dlq.correlationId ? `${dlq.correlationId}:replay` : undefined;
  const envelope = createEnvelope(dlq.originalTopic, dlq.payload as T, replayCorrelation);
  const headers: Record<string, string> = {
    'x-original-topic': dlq.originalTopic,
  };
  if (replayCorrelation) {
    headers['x-correlation-id'] = replayCorrelation;
  }
  await bus.publish(envelope.topic, envelope, headers);
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
