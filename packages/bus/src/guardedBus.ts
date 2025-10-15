import type { Handler, Message, MessageBus, Subscription } from './types';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';

const GUARDED_SYMBOL = Symbol.for('onecare.bus.guarded');
const CORRELATION_HEADER = 'x-correlation-id';
const MESSAGE_ID_HEADER = 'x-message-id';

export interface MessageBusGuardOptions {
  allowedTopics: Iterable<string>;
  enforceEnvelope?: boolean;
  requireCorrelationHeader?: boolean;
  idempotencyStore?: IdempotencyStore | null;
  idempotencyTtlSeconds?: number;
  onDuplicate?: (message: Message) => Promise<void> | void;
}

interface NormalizedGuardOptions {
  allowedTopics: Set<string>;
  enforceEnvelope: boolean;
  requireCorrelationHeader: boolean;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds: number;
  onDuplicate?: (message: Message) => Promise<void> | void;
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
      if (!normalized) {
        return;
      }
      if (this.options.idempotencyStore) {
        await executeWithIdempotency({
          store: this.options.idempotencyStore,
          key: buildIdempotencyKey(topic, normalized, this.options),
          ttlSeconds: this.options.idempotencyTtlSeconds,
          execute: async () => {
            await handler(normalized as Message<T>);
            return true as const;
          },
          onDuplicate: async () => {
            await Promise.resolve(this.options.onDuplicate?.(normalized));
          },
        });
        return;
      }
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
    const normalizedHeaders = this.ensureHeaders(envelope, headers, false);
    return { payload, headers: normalizedHeaders };
  }

  private normalizeIncoming<T>(message: Message<T>): Message<T> {
    this.assertAllowedTopic(message.topic);
    if (!this.options.enforceEnvelope) {
      return message;
    }
    const envelope = this.assertEnvelope(message.payload as EnvelopeCandidate, message.topic, 'subscribe');
    const normalizedHeaders = this.ensureHeaders(envelope, message.headers, true);
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
    envelope: {
      id: string;
      correlationId?: string;
    },
    headers: Record<string, string> | undefined,
    incoming: boolean
  ): Record<string, string> | undefined {
    const withCorrelation = this.ensureCorrelationHeader(envelope.correlationId, headers, incoming);
    return this.ensureMessageIdHeader(envelope.id, withCorrelation, incoming);
  }

  private ensureCorrelationHeader(
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
    if (incoming) {
      return headers;
    }
    const next = { ...headers };
    delete next[located.key];
    next[CORRELATION_HEADER] = trimmed;
    return next;
  }

  private ensureMessageIdHeader(
    messageId: string,
    headers: Record<string, string> | undefined,
    incoming: boolean
  ): Record<string, string> | undefined {
    const trimmed = messageId.trim();
    if (!headers) {
      return { [MESSAGE_ID_HEADER]: trimmed };
    }
    const located = findHeader(headers, MESSAGE_ID_HEADER);
    if (located && located.value.length > 0 && located.value !== trimmed) {
      throw new Error(
        `[MessageBusGuard] message_id_mismatch: envelope=${trimmed} header=${String(located.value)}`
      );
    }
    if (!located) {
      return {
        ...headers,
        [MESSAGE_ID_HEADER]: trimmed,
      };
    }
    if (located.key === MESSAGE_ID_HEADER) {
      return headers;
    }
    if (incoming) {
      return headers;
    }
    const next = { ...headers };
    delete next[located.key];
    next[MESSAGE_ID_HEADER] = trimmed;
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
  const ttlSeconds = normalizeTtlSeconds(options.idempotencyTtlSeconds);
  return {
    allowedTopics,
    enforceEnvelope: options.enforceEnvelope !== false,
    requireCorrelationHeader: options.requireCorrelationHeader !== false,
    idempotencyStore: options.idempotencyStore ?? undefined,
    idempotencyTtlSeconds: ttlSeconds,
    onDuplicate: options.onDuplicate,
  };
}

function normalizeTtlSeconds(candidate: number | undefined): number {
  if (!Number.isFinite(candidate) || candidate === undefined) {
    return 600;
  }
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 600;
  }
  return Math.min(86_400, Math.max(30, Math.floor(parsed)));
}

function buildIdempotencyKey(topic: string, message: Message, options: NormalizedGuardOptions): string {
  const headers = message.headers ?? {};
  const located = findHeader(headers, MESSAGE_ID_HEADER);
  const fromHeader = located?.value?.trim();
  const envelope = message.payload as EnvelopeCandidate;
  const fallback = typeof envelope?.id === 'string' ? envelope.id.trim() : undefined;
  const idCandidate = fromHeader && fromHeader.length > 0 ? fromHeader : fallback;
  if (!idCandidate || idCandidate.length === 0) {
    return `bus:${topic}:unknown`;
  }
  return `bus:${topic}:${idCandidate}`;
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
