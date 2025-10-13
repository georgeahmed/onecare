import type { Handler, Message, MessageBus, Subscription } from './types';

const GUARDED_SYMBOL = Symbol.for('onecare.bus.guarded');
const CORRELATION_HEADER = 'x-correlation-id';

export interface MessageBusGuardOptions {
  allowedTopics: Iterable<string>;
  enforceEnvelope?: boolean;
  requireCorrelationHeader?: boolean;
}

interface NormalizedGuardOptions {
  allowedTopics: Set<string>;
  enforceEnvelope: boolean;
  requireCorrelationHeader: boolean;
}

interface EnvelopeCandidate {
  topic?: unknown;
  id?: unknown;
  timestamp?: unknown;
  payload?: unknown;
  correlationId?: unknown;
}

interface GuardedPublish<T> {
  payload: T;
  headers?: Record<string, string>;
}

class GuardedMessageBus implements MessageBus {
  public readonly [GUARDED_SYMBOL] = true;

  constructor(private readonly inner: MessageBus, private readonly options: NormalizedGuardOptions) {}

  get innerBus(): MessageBus {
    return this.inner;
  }

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.assertAllowedTopic(topic);
    const normalized = this.normalizeOutgoing(topic, payload, headers);
    await this.inner.publish(topic, normalized.payload, normalized.headers);
  }

  async subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription> {
    this.assertAllowedTopic(topic);
    return this.inner.subscribe(topic, async (message) => {
      const normalized = this.normalizeIncoming(message);
      await handler(normalized as Message<T>);
    });
  }

  private assertAllowedTopic(topic: string): void {
    if (!this.options.allowedTopics.has(topic)) {
      throw new Error(`[MessageBusGuard] topic_not_allowlisted: ${topic}`);
    }
  }

  private normalizeOutgoing<T>(topic: string, payload: T, headers?: Record<string, string>): GuardedPublish<T> {
    if (!this.options.enforceEnvelope) {
      return { payload, headers };
    }
    const envelope = this.assertEnvelope(payload as EnvelopeCandidate, topic, 'publish');
    const normalizedHeaders = this.ensureHeaders(envelope.correlationId, headers, false);
    return { payload, headers: normalizedHeaders };
  }

  private normalizeIncoming<T>(message: Message<T>): Message<T> {
    this.assertAllowedTopic(message.topic);
    if (!this.options.enforceEnvelope) {
      return message;
    }
    const envelope = this.assertEnvelope(message.payload as EnvelopeCandidate, message.topic, 'subscribe');
    const normalizedHeaders = this.ensureHeaders(envelope.correlationId, message.headers, true);
    if (normalizedHeaders === message.headers) {
      return message;
    }
    return {
      ...message,
      headers: normalizedHeaders,
    };
  }

  private assertEnvelope(candidate: EnvelopeCandidate, expectedTopic: string, phase: 'publish' | 'subscribe') {
    if (candidate == null || typeof candidate !== 'object') {
      throw new Error(`[MessageBusGuard] envelope_missing (${phase}): ${expectedTopic}`);
    }
    const { topic, id, timestamp } = candidate;
    if (typeof topic !== 'string' || topic.length === 0) {
      throw new Error(`[MessageBusGuard] envelope_topic_missing (${phase}): ${expectedTopic}`);
    }
    if (topic !== expectedTopic) {
      throw new Error(
        `[MessageBusGuard] envelope_topic_mismatch (${phase}): expected=${expectedTopic} actual=${String(topic)}`
      );
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`[MessageBusGuard] envelope_id_missing (${phase}): ${expectedTopic}`);
    }
    if (typeof timestamp !== 'string' || timestamp.length === 0) {
      throw new Error(`[MessageBusGuard] envelope_timestamp_missing (${phase}): ${expectedTopic}`);
    }
    if (!('payload' in candidate)) {
      throw new Error(`[MessageBusGuard] envelope_payload_missing (${phase}): ${expectedTopic}`);
    }
    const { correlationId } = candidate;
    if (correlationId !== undefined && (typeof correlationId !== 'string' || correlationId.length === 0)) {
      throw new Error(`[MessageBusGuard] envelope_correlation_invalid (${phase}): ${expectedTopic}`);
    }
    return candidate as {
      topic: string;
      id: string;
      timestamp: string;
      payload: unknown;
      correlationId?: string;
    };
  }

  private ensureHeaders(
    correlationId: string | undefined,
    headers: Record<string, string> | undefined,
    incoming: boolean
  ): Record<string, string> | undefined {
    if (!this.options.requireCorrelationHeader || correlationId === undefined) {
      return headers;
    }
    const trimmed = correlationId.trim();
    if (trimmed.length === 0) {
      return headers;
    }
    if (!headers) {
      if (incoming) {
        throw new Error('[MessageBusGuard] correlation_header_missing (incoming)');
      }
      return { [CORRELATION_HEADER]: trimmed };
    }
    const located = findHeader(headers, CORRELATION_HEADER);
    if (located && located.value.length > 0 && located.value !== trimmed) {
      throw new Error(
        `[MessageBusGuard] correlation_id_mismatch: envelope=${trimmed} header=${String(located.value)}`
      );
    }
    if (!located) {
      if (incoming) {
        throw new Error('[MessageBusGuard] correlation_header_missing (incoming)');
      }
      return {
        ...headers,
        [CORRELATION_HEADER]: trimmed,
      };
    }
    if (located.key === CORRELATION_HEADER) {
      return headers;
    }
    // Existing header uses different casing. Preserve the original record shape to avoid surprises.
    if (incoming) {
      return headers;
    }
    const next = { ...headers };
    delete next[located.key];
    next[CORRELATION_HEADER] = trimmed;
    return next;
  }
}

function findHeader(
  headers: Record<string, string>,
  name: string
): { key: string; value: string } | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return { key, value };
    }
  }
  return undefined;
}

function normalizeOptions(options: MessageBusGuardOptions): NormalizedGuardOptions {
  const allowedTopics = new Set<string>();
  for (const topic of options.allowedTopics) {
    if (typeof topic === 'string' && topic.length > 0) {
      allowedTopics.add(topic);
    }
  }
  if (allowedTopics.size === 0) {
    throw new Error('[MessageBusGuard] allowedTopics must contain at least one topic');
  }
  return {
    allowedTopics,
    enforceEnvelope: options.enforceEnvelope !== false,
    requireCorrelationHeader: options.requireCorrelationHeader !== false,
  };
}

export function withMessageGuards(bus: MessageBus, options: MessageBusGuardOptions): MessageBus {
  if (isGuardedBus(bus)) {
    return bus;
  }
  const normalized = normalizeOptions(options);
  return new GuardedMessageBus(bus, normalized);
}

export function isGuardedBus(bus: MessageBus): bus is GuardedMessageBus {
  return Boolean((bus as GuardedMessageBus | undefined)?.[GUARDED_SYMBOL]);
}

export function unwrapGuardedBus(bus: MessageBus): MessageBus {
  let current = bus;
  while (isGuardedBus(current)) {
    current = (current as GuardedMessageBus).innerBus;
  }
  return current;
}

