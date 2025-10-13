import { randomUUID } from 'node:crypto';
import { EventEnvelope } from './contracts/envelope';

// Typed helper preserving generated, non-generic contract while giving payload type safety.
export type TypedEnvelope<T> = EventEnvelope & { payload: T };

export function createEnvelope<T>(topic: string, payload: T, correlationId?: string): TypedEnvelope<T> {
  return {
    id: randomUUID(),
    topic,
    timestamp: new Date().toISOString(),
    payload,
    correlationId,
  } as TypedEnvelope<T>;
}
