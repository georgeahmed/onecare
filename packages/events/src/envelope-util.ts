import { EventEnvelope } from './contracts/envelope';

// Typed helper preserving generated, non-generic contract while giving payload type safety.
export type TypedEnvelope<T> = EventEnvelope & { payload: T };

export function createEnvelope<T>(topic: string, payload: T, correlationId?: string): TypedEnvelope<T> {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    topic,
    timestamp: new Date().toISOString(),
    payload,
    correlationId,
  } as TypedEnvelope<T>;
}
