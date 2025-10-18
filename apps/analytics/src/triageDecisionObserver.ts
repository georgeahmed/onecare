import type { Message, MessageBus, Subscription } from '@onecare/bus';
import { getBus, withMessageGuards } from '@onecare/bus';
import { Topics, type TypedEnvelope } from '@onecare/events';
import type { TriageDecision } from '@onecare/events';
import { validate } from '@onecare/domain';
import { logger, ensureTracing, createCounter, createHistogram } from '@onecare/observability';

ensureTracing('analytics-triage-decision');

const TRIAGE_DECISION_SCHEMA_ID = 'https://onecare/schemas/triage/triage-decision.json';
const TRIAGE_DECISION_ALLOWED_TOPICS = new Set<string>([Topics.triage.decision ?? 'triage.decision']);

const triageDecisionCounter = createCounter('analytics.triage_decision.observed_total');
const triageDecisionDuplicateCounter = createCounter('analytics.triage_decision.duplicate_total');
const triageDecisionScoreHistogram = createHistogram('analytics.triage_decision.score');

export interface TriageDecisionObserverOptions {
  bus?: MessageBus;
}

export class TriageDecisionObserver {
  private readonly bus: MessageBus;
  private subscription: Subscription | null = null;

  constructor(options: TriageDecisionObserverOptions = {}) {
    const baseBus = options.bus ?? getBus();
    this.bus = withMessageGuards(baseBus, { allowedTopics: TRIAGE_DECISION_ALLOWED_TOPICS });
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = await this.bus.subscribe<Message<TypedEnvelope<TriageDecision>>>(
      Topics.triage.decision ?? 'triage.decision',
      async (message) => {
        await this.handleEnvelope(message.payload);
      },
    );
    logger.info('triage decision observer subscribed', { topic: Topics.triage.decision ?? 'triage.decision' });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    await this.subscription.unsubscribe();
    this.subscription = null;
    logger.info('triage decision observer unsubscribed', { topic: Topics.triage.decision ?? 'triage.decision' });
  }

  private async handleEnvelope(envelope: TypedEnvelope<TriageDecision>): Promise<void> {
    const { correlationId, payload, id } = envelope;
    const validation = validate(TRIAGE_DECISION_SCHEMA_ID, payload);
    if (!validation.ok) {
      logger.warn('triage.decision payload failed validation', {
        correlationId,
        errors: validation.errors,
      });
      return;
    }

    const priority = payload.priority;
    const duplicate = Boolean(payload.duplicateOf);
    const score = typeof payload.score === 'number' ? payload.score : undefined;

    triageDecisionCounter.add(1, {
      priority,
    });
    if (duplicate) {
      triageDecisionDuplicateCounter.add(1, { priority });
    }
    if (typeof score === 'number') {
      triageDecisionScoreHistogram.record(score, { priority });
    }

    logger.info('triage decision observed', {
      correlationId,
      eventId: id,
      priority,
      duplicate,
      reasons: payload.reasons?.slice(0, 5),
      hasAssignment: Boolean(payload.assignment?.owner || payload.assignment?.team),
    });
  }
}

export async function startTriageDecisionObserver(options: TriageDecisionObserverOptions = {}): Promise<TriageDecisionObserver> {
  const observer = new TriageDecisionObserver(options);
  await observer.start();
  return observer;
}
