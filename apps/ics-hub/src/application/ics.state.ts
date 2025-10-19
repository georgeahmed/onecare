import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { IcsClient } from '../adapters/ics.client';
import type { IcsOrganisationPolicy, ResolvedConfig } from '@onecare/config';
import { getIcsOrganisationPolicies } from '@onecare/config';
import { createCounter, createHistogram, logger, startSpan } from '@onecare/observability';
import type {
  TypedEnvelope,
  IcsReferralRequest,
  AuditEvent,
  ErrorEnvelope,
  IcsReferralAck,
} from '@onecare/events';
import type { MessageBus } from '@onecare/bus';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import {
  publishAutomationTasks,
  publishReferralAck,
  type AutomationPublishOptions,
  type PublishOptions as BusPublishOptions,
} from '../adapters/bus.adapter';
import { buildRouteDecision, type RouteDecision, type RoutingConfig } from './routing';
import { validateReferralIngress } from './ingress';
import { createErrorEnvelope } from './errors';
import {
  evaluateAutomationTriggers,
  buildAutomationTaskCreations,
  loadAutomationConfig,
  type AutomationTriggerConfig,
  type AutomationTriggerEvent,
  type AutomationIntent,
  type AutomationTaskCreation,
} from './automation.rules';
import { SpanStatusCode } from '@opentelemetry/api';
import { AuditSpool } from './audit.spool';
import { ProcessingLimiter } from './backpressure';

const routingDecisionCounter = createCounter('ics.routing.decisions_total');
const routingBlockedCounter = createCounter('ics.routing.blocked_total');
const routingRateLimitedCounter = createCounter('ics.routing.rate_limited_total');
const routingLatencyHistogram = createHistogram('ics.routing.latency_ms');
const processingOverloadCounter = createCounter('ics.backpressure.overload_total');
const ackPublishedCounter = createCounter('ics.ack.published_total');
const ackFailureCounter = createCounter('ics.ack.failed_total');
const ackDuplicateCounter = createCounter('ics.ack.duplicate_total');
const ackLatencyHistogram = createHistogram('ics.ack.latency_ms');

const RATE_WINDOW_MS = 60_000;
const DEFAULT_ICS_IDEMPOTENCY_TTL_SECONDS = 5 * 60;

function normaliseOrgId(orgId: string): string {
  return orgId.trim().toLowerCase();
}

interface TokenBucketResult {
  allowed: boolean;
  retryAfterMs?: number;
}

class TokenBucketLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(private limit: number | undefined, private readonly now: () => number) {}

  updateLimit(limit?: number): void {
    this.limit = limit;
    if (!limit || limit <= 0) {
      this.windowStart = 0;
      this.count = 0;
    } else if (this.count > limit) {
      this.count = limit;
    }
  }

  tryConsume(): TokenBucketResult {
    const limit = this.limit;
    if (!limit || limit <= 0) {
      return { allowed: true };
    }
    const now = this.now();
    if (this.windowStart === 0 || now - this.windowStart >= RATE_WINDOW_MS) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= limit) {
      const retryAfterMs = Math.max(0, this.windowStart + RATE_WINDOW_MS - now);
      return { allowed: false, retryAfterMs };
    }
    this.count += 1;
    return { allowed: true };
  }
}

export type RoutingOutcome =
  | {
      status: 'allowed';
      policy: IcsOrganisationPolicy;
      routeDecision: RouteDecision;
    }
  | {
      status: 'forbidden';
      httpStatus: 403;
      error: ErrorEnvelope;
    }
  | {
      status: 'rate_limited';
      httpStatus: 429;
      error: ErrorEnvelope;
      retryAfterMs?: number;
      policy: IcsOrganisationPolicy;
      routeDecision: RouteDecision;
    }
  | {
      status: 'invalid';
      httpStatus: 400;
      error: ErrorEnvelope;
    };

export interface IcsContext extends MachineContext {
  client?: IcsClient;
  bus?: MessageBus;
  organisationId?: string;
  claim?: unknown;
  correlationId?: string;
  createTaskId?: () => string;
  blocked?: boolean;
  rateLimited?: boolean;
  routePolicy?: IcsOrganisationPolicy;
  routingOutcome?: RoutingOutcome;
  rawEnvelope?: unknown;
  referralEnvelope?: TypedEnvelope<IcsReferralRequest>;
  referral?: IcsReferralRequest;
  routeDecision?: RouteDecision;
  destinationOrgId?: string;
  auditIntents?: AuditEvent[];
  invalid?: boolean;
  receivedAtMs?: number;
  automationConfig?: AutomationTriggerConfig;
  automationEvent?: AutomationTriggerEvent;
  automationIntents?: AutomationIntent[];
  automationTasks?: AutomationTaskCreation[];
  automationPublished?: boolean;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  automationPublishIdempotencyKey?: string;
  ack?: IcsReferralAck;
  ackPublished?: boolean;
  ackPublishIdempotencyKey?: string;
  ackPublishOptions?: BusPublishOptions;
  ackLatencyMs?: number;
  responseHeaders?: Record<string, string>;
  retryAfterSeconds?: number;
  auditSpool?: AuditSpool;
  processingLimiter?: ProcessingLimiter;
  processingRelease?: (() => void) | null;
}

export interface IcsEvent extends MachineEvent {
  type: 'ics.route' | string;
}

type OrgPolicyMap = Record<string, IcsOrganisationPolicy>;

export interface InboundStateOptions {
  now?: () => number;
}

export class InboundState extends BaseState<IcsContext, IcsEvent> {
  private readonly policies = new Map<string, IcsOrganisationPolicy>();
  private readonly limiters = new Map<string, TokenBucketLimiter>();
  private readonly now: () => number;
  private routingConfig: RoutingConfig;

  constructor(policies: OrgPolicyMap = {}, routing: RoutingConfig = {}, options: InboundStateOptions = {}) {
    super('Inbound');
    this.now = options.now ?? Date.now;
    this.routingConfig = routing;
    this.applyPolicies(policies);
  }

  static fromConfig(config: ResolvedConfig): InboundState {
    return new InboundState(getIcsOrganisationPolicies(config));
  }

  private applyPolicies(policies: OrgPolicyMap): void {
    this.policies.clear();
    this.limiters.clear();
    for (const [org, policy] of Object.entries(policies)) {
      const normalised = normaliseOrgId(org);
      this.policies.set(normalised, policy);
      this.limiters.set(normalised, new TokenBucketLimiter(policy.rateLimit, this.now));
    }
  }

  private getLimiter(orgId: string, policy: IcsOrganisationPolicy): TokenBucketLimiter {
    let limiter = this.limiters.get(orgId);
    if (!limiter) {
      limiter = new TokenBucketLimiter(policy.rateLimit, this.now);
      this.limiters.set(orgId, limiter);
      return limiter;
    }
    limiter.updateLimit(policy.rateLimit);
    return limiter;
  }

  async handle(ctx: IcsContext, _event: IcsEvent): Promise<string> {
    if (!ctx.auditIntents) {
      ctx.auditIntents = [];
    }
    if (ctx.processingLimiter && !ctx.processingRelease) {
      if (ctx.processingLimiter.isOverloaded()) {
        applyBackpressureOutcome(ctx, ctx.processingLimiter, 'overloaded');
        releaseProcessing(ctx);
        return 'Validated';
      }
      try {
        ctx.processingRelease = await ctx.processingLimiter.acquire(ctx.id ?? 'ics-message');
      } catch (error) {
        applyBackpressureOutcome(ctx, ctx.processingLimiter, 'queue_overflow');
        releaseProcessing(ctx);
        return 'Validated';
      }
    }
    if (!ctx.client) {
      throw new Error('ics_client_missing');
    }

    ctx.responseHeaders = {};
    ctx.retryAfterSeconds = undefined;
    ctx.receivedAtMs = this.now();
    ctx.ackPublished = false;
    ctx.ack = undefined;

    const validation = validateReferralIngress(ctx.rawEnvelope ?? ctx.referralEnvelope);
    if (!validation.ok) {
      ctx.invalid = true;
      ctx.blocked = false;
      ctx.rateLimited = false;
      ctx.routePolicy = undefined;
      ctx.routeDecision = undefined;
      ctx.routingOutcome = {
        status: 'invalid',
        httpStatus: 400,
        error: validation.error,
      };
      pushAudit(ctx, 'ics.referral.validation_failed', { reason: validation.reason }, undefined, this.now);
      routingDecisionCounter.add(1, { outcome: 'invalid' });
      releaseProcessing(ctx);
      return 'Validated';
    }

    const envelope = validation.envelope;
    ctx.rawEnvelope = envelope;
    ctx.referralEnvelope = envelope;
    ctx.referral = envelope.payload;
    ctx.correlationId = validation.correlationId;

    const requestedOrgRaw = envelope.payload.org ?? '';
    const requestedOrg = requestedOrgRaw.trim();
    if (!requestedOrg) {
      ctx.invalid = true;
      ctx.blocked = false;
      ctx.rateLimited = false;
      ctx.routePolicy = undefined;
      ctx.routeDecision = undefined;
      ctx.routingOutcome = {
        status: 'invalid',
        httpStatus: 400,
        error: createErrorEnvelope(
          'invalid_input',
          'organisation_missing',
          { referralId: envelope.payload.referralId },
          ctx.correlationId,
        ),
      };
      pushAudit(
        ctx,
        'ics.referral.validation_failed',
        {
          reason: 'organisation_missing',
          referralId: envelope.payload.referralId,
        },
        undefined,
        this.now,
      );
      routingDecisionCounter.add(1, { outcome: 'invalid' });
      releaseProcessing(ctx);
      return 'Validated';
    }

    const correlationId = ctx.correlationId;
    pushAudit(
      ctx,
      'ics.referral.received',
      {
        referralId: envelope.payload.referralId,
        organisationId: requestedOrg,
      },
      correlationId,
      this.now,
    );

    const normalisedOrg = normaliseOrgId(requestedOrg);
    ctx.organisationId = normalisedOrg;

    const routeDecision = buildRouteDecision(envelope.payload, this.routingConfig);
    ctx.routeDecision = routeDecision;
    ctx.destinationOrgId = routeDecision.destinationOrgId;
    pushAudit(
      ctx,
      'ics.referral.route_decided',
      {
        referralId: envelope.payload.referralId,
        destinationOrgId: routeDecision.destinationOrgId,
        policy: routeDecision.policy,
      },
      correlationId,
      this.now,
    );

    const policy = this.policies.get(normalisedOrg);
    if (!policy) {
      ctx.blocked = true;
      ctx.rateLimited = false;
      ctx.routePolicy = undefined;
      ctx.routingOutcome = {
        status: 'forbidden',
        httpStatus: 403,
        error: createErrorEnvelope(
          'forbidden',
          'organisation_not_allowed',
          {
            organisationId: normalisedOrg,
          },
          correlationId,
        ),
      };
      logger.warn('ics.routing.blocked', {
        organisationId: normalisedOrg,
        correlationId,
        result: 'blocked',
      });
      routingDecisionCounter.add(1, { outcome: 'blocked', organisationId: normalisedOrg });
      routingBlockedCounter.add(1, { organisationId: normalisedOrg });
      releaseProcessing(ctx);
      return 'Validated';
    }

    const limiter = this.getLimiter(normalisedOrg, policy);
    const bucketResult = limiter.tryConsume();
    if (!bucketResult.allowed) {
      ctx.blocked = false;
      ctx.rateLimited = true;
      ctx.routePolicy = policy;
      const retryAfterMs = bucketResult.retryAfterMs;
      ctx.routingOutcome = {
        status: 'rate_limited',
        httpStatus: 429,
        policy,
        retryAfterMs,
        routeDecision,
        error: createErrorEnvelope(
          'too_many_requests',
          'rate_limit_exceeded',
          {
            organisationId: normalisedOrg,
            limitPerMinute: policy.rateLimit,
            retryAfterMs,
          },
          correlationId,
        ),
      };
      if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) {
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
        ctx.retryAfterSeconds = seconds;
        ctx.responseHeaders ??= {};
        ctx.responseHeaders['Retry-After'] = String(seconds);
      }
      logger.warn('ics.routing.rate_limited', {
        organisationId: normalisedOrg,
        correlationId,
        result: 'rate_limited',
        limitPerMinute: policy.rateLimit,
      });
      routingDecisionCounter.add(1, { outcome: 'rate_limited', organisationId: normalisedOrg });
      routingRateLimitedCounter.add(1, { organisationId: normalisedOrg });
      releaseProcessing(ctx);
      return 'Validated';
    }

    ctx.blocked = false;
    ctx.rateLimited = false;
    ctx.routePolicy = policy;
    ctx.routingOutcome = {
      status: 'allowed',
      policy,
      routeDecision,
    };
    routingDecisionCounter.add(1, { outcome: 'allowed', organisationId: normalisedOrg });
    return 'Validated';
  }

}

export class ValidatedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Validated');
  }

  async handle(ctx: IcsContext, _event: IcsEvent): Promise<string> {
    if (ctx.routingOutcome?.status === 'invalid') {
      ctx.invalid = true;
      releaseProcessing(ctx);
      return 'Invalid';
    }
    if (ctx.blocked) {
      ctx.routingOutcome ??= {
        status: 'forbidden',
        httpStatus: 403,
        error: createErrorEnvelope('forbidden', 'organisation_not_allowed'),
      };
      releaseProcessing(ctx);
      return 'Blocked';
    }
    if (ctx.rateLimited) {
      ctx.routingOutcome ??= {
        status: 'rate_limited',
        httpStatus: 429,
        policy: ctx.routePolicy!,
        routeDecision: ctx.routeDecision ?? buildRouteDecisionFromContext(ctx),
        error: createErrorEnvelope('too_many_requests', 'rate_limit_exceeded'),
      };
      releaseProcessing(ctx);
      return 'RateLimited';
    }
    if (!ctx.routePolicy) {
      throw new Error('route_policy_missing');
    }
    if (typeof ctx.receivedAtMs === 'number') {
      const latency = Math.max(0, Date.now() - ctx.receivedAtMs);
      routingLatencyHistogram.record(latency, {
        organisationId: ctx.organisationId ?? 'unknown',
      });
    }
    return 'Routed';
  }
}

export class RoutedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Routed');
  }

  async handle(ctx: IcsContext, _event: IcsEvent): Promise<string> {
    if (!ctx.client) {
      throw new Error('ics_client_missing');
    }
    if (!ctx.referral) {
      throw new Error('ics_referral_missing');
    }
    if (!ctx.bus) {
      throw new Error('ics_bus_missing');
    }
    try {
    const destinationOrgId = ctx.routeDecision?.destinationOrgId ?? ctx.organisationId ?? ctx.referral.org;
    const correlationId = ctx.correlationId;
    const idempotencyKey = deriveAckIdempotencyKey(ctx, destinationOrgId);
    const ttlSeconds = resolveIcsIdempotencyTtl(ctx);
    ctx.ackPublishIdempotencyKey = idempotencyKey;

    const { status, result } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key: idempotencyKey,
      ttlSeconds,
      execute: async () => {
        const span = startSpan('ics.referral.ack', {
          attributes: {
            'ics.destination_org': destinationOrgId ?? 'unknown-org',
            'ics.referral_id': ctx.referral?.referralId ?? 'unknown-referral',
          },
        });
        const attemptStartedAt = Date.now();
        try {
          const ack = await ctx.client!.sendReferral(ctx.referral!, {
            correlationId,
            organisationIdOverride: destinationOrgId,
          });
          ctx.ack = ack;
          await publishReferralAck(ctx.bus!, ack, correlationId, ctx.ackPublishOptions);
          ctx.ackPublished = true;
          const latency =
            typeof ctx.receivedAtMs === 'number'
              ? Date.now() - ctx.receivedAtMs
              : Date.now() - attemptStartedAt;
          ctx.ackLatencyMs = latency;
          const metricLabels = {
            destinationOrgId,
            accepted: ack.accepted ? 'true' : 'false',
          };
          ackPublishedCounter.add(1, metricLabels);
          if (Number.isFinite(latency) && latency >= 0) {
            ackLatencyHistogram.record(latency, metricLabels);
          }
          pushAudit(
            ctx,
            'ics.referral.ack_published',
            {
              referralId: ack.referralId,
              destinationOrgId,
              accepted: ack.accepted,
            },
            correlationId,
          );
          logger.info('ics.referral.ack_published', {
            referralId: ack.referralId,
            destinationOrgId,
            correlationId,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return ack;
        } catch (error) {
          ackFailureCounter.add(1, { destinationOrgId });
          if (error instanceof Error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            logger.error('ics.referral.ack_failed', {
              referralId: ctx.referral?.referralId,
              destinationOrgId,
              correlationId,
              reason: error.message,
            });
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'unknown_error' });
            logger.error('ics.referral.ack_failed', {
              referralId: ctx.referral?.referralId,
              destinationOrgId,
              correlationId,
              reason: 'unknown_error',
            });
          }
          throw error;
        } finally {
          span.end();
        }
      },
      onDuplicate: () => {
        ctx.ackPublished = true;
        ackDuplicateCounter.add(1, { destinationOrgId });
        logger.warn('ics.referral.ack_duplicate', {
          referralId: ctx.referral?.referralId,
          destinationOrgId,
          correlationId,
        });
      },
    });

    if (status === 'executed' && result) {
      ctx.ack = result;
    }

    return 'Acked';
    } finally {
      releaseProcessing(ctx);
    }
  }
}

export class InvalidState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Invalid');
  }

  async handle(_ctx: IcsContext, _event: IcsEvent): Promise<string> {
    releaseProcessing(_ctx);
    return 'Invalid';
  }
}

export class BlockedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Blocked');
  }

  async handle(ctx: IcsContext, _event: IcsEvent): Promise<string> {
    releaseProcessing(ctx);
    return 'Blocked';
  }
}

export class RateLimitedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('RateLimited');
  }

  async handle(ctx: IcsContext, _event: IcsEvent): Promise<string> {
    if (
      typeof ctx.retryAfterSeconds === 'number' &&
      Number.isFinite(ctx.retryAfterSeconds) &&
      ctx.retryAfterSeconds > 0
    ) {
      ctx.responseHeaders ??= {};
      if (!ctx.responseHeaders['Retry-After']) {
        ctx.responseHeaders['Retry-After'] = String(Math.ceil(ctx.retryAfterSeconds));
      }
    }
    releaseProcessing(ctx);
    return 'RateLimited';
  }
}

function buildRouteDecisionFromContext(ctx: IcsContext): RouteDecision {
  if (ctx.routeDecision) return ctx.routeDecision;
  if (ctx.referral) {
    return buildRouteDecision(ctx.referral, {});
  }
  return {
    destinationOrgId: ctx.destinationOrgId ?? 'unknown',
    policy: 'fallback',
    rationale: 'route decision unavailable; using fallback',
  };
}

export interface AutomationEvaluationOptions {
  config?: AutomationTriggerConfig;
  createTaskId?: () => string;
  correlationId?: string;
  now?: () => string;
}

export function evaluateAutomation(
  ctx: IcsContext,
  event: AutomationTriggerEvent,
  options: AutomationEvaluationOptions = {},
): AutomationTaskCreation[] {
  if (!event || !event.current) {
    throw new Error('automation_event_invalid');
  }

  const config =
    options.config ??
    ctx.automationConfig ??
    loadAutomationConfig();
  ctx.automationConfig = config;
  ctx.automationEvent = event;

  if (options.createTaskId) {
    ctx.createTaskId = options.createTaskId;
  }

  if (options.correlationId) {
    ctx.correlationId = options.correlationId;
  } else if (!ctx.correlationId && event.correlationId) {
    ctx.correlationId = event.correlationId;
  }

  const intents = evaluateAutomationTriggers(event, config);
  ctx.automationIntents = intents;

  const tasks = buildAutomationTaskCreations(intents, {
    createTaskId: ctx.createTaskId,
    correlationId: ctx.correlationId,
    now: options.now,
  });
  ctx.automationTasks = tasks;
  if (tasks.length > 0) {
    const publishKey = buildAutomationPublishKey(ctx, event, tasks);
    if (publishKey) {
      ctx.automationPublishIdempotencyKey = publishKey;
    }
    const debounceTtl = deriveAutomationDebounceTtl(tasks);
    if (debounceTtl) {
      const currentTtl = typeof ctx.idempotencyTtlSeconds === 'number' ? ctx.idempotencyTtlSeconds : 0;
      ctx.idempotencyTtlSeconds = Math.max(currentTtl, debounceTtl);
    }
  }
  return tasks;
}

export async function publishAutomationOutputs(
  ctx: IcsContext,
  options: AutomationPublishOptions = {},
): Promise<void> {
  if (!ctx.bus) {
    throw new Error('automation_bus_missing');
  }
  if (!ctx.automationTasks || ctx.automationTasks.length === 0) {
    return;
  }
  const key = deriveAutomationPublishKey(ctx);
  const ttlSeconds = resolveIcsIdempotencyTtl(ctx);
  const { status } = await executeWithIdempotency({
    store: ctx.idempotencyStore,
    key,
    ttlSeconds,
    execute: async () => {
      await publishAutomationTasks(ctx.bus!, ctx.automationTasks, options);
      ctx.automationPublished = true;
      logger.info('ics.automation.outputs_published', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        key,
        taskCount: ctx.automationTasks?.length ?? 0,
      });
      return true;
    },
    onDuplicate: () => {
      logger.warn('ics.automation.publish_duplicate', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        key,
      });
    },
    onError: (error) => {
      logger.error('ics.automation.publish_failed', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        key,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    },
  });

  if (status === 'skipped') {
    ctx.automationPublished = ctx.automationPublished ?? true;
  }
}

function resolveIcsIdempotencyTtl(ctx: IcsContext): number {
  const ttl = ctx.idempotencyTtlSeconds;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ICS_IDEMPOTENCY_TTL_SECONDS;
}

function deriveAutomationPublishKey(ctx: IcsContext): string {
  if (ctx.automationPublishIdempotencyKey) return ctx.automationPublishIdempotencyKey;
  return `ics:automation:${ctx.organisationId ?? 'unknown-org'}:${ctx.id}`;
}

function buildAutomationPublishKey(
  ctx: IcsContext,
  event: AutomationTriggerEvent,
  tasks: AutomationTaskCreation[],
): string {
  const orgSegment = ctx.organisationId ?? 'unknown-org';
  const sourceTaskId = event.current?.taskId ?? 'unknown-task';
  const ruleSegment = tasks
    .map((task) => `${task.ruleName}:${task.task.patientId}`)
    .sort()
    .join('|') || 'none';
  const correlationSegment = event.correlationId ?? ctx.correlationId ?? 'none';
  return `ics:automation:${orgSegment}:${sourceTaskId}:${ruleSegment}:${correlationSegment}`;
}

function deriveAutomationDebounceTtl(tasks: AutomationTaskCreation[]): number | undefined {
  const windows = tasks
    .map((task) => task.debounceWindowSeconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (windows.length === 0) return undefined;
  return Math.max(...windows);
}

function applyBackpressureOutcome(
  ctx: IcsContext,
  limiter: ProcessingLimiter,
  reason: 'overloaded' | 'queue_overflow',
): void {
  const retryAfterSeconds = limiter.retryAfterSecondsValue;
  ctx.rateLimited = true;
  ctx.blocked = false;
  ctx.retryAfterSeconds = retryAfterSeconds;
  ctx.responseHeaders ??= {};
  ctx.responseHeaders['Retry-After'] = String(retryAfterSeconds);
  ctx.routePolicy ??= { endpoint: 'ics-backpressure', rateLimit: limiter.capacity } as IcsOrganisationPolicy;
  const decision = ctx.routeDecision ?? buildRouteDecisionFromContext(ctx);
  ctx.routeDecision = decision;
  ctx.routingOutcome = {
    status: 'rate_limited',
    httpStatus: 429,
    policy: ctx.routePolicy!,
    retryAfterMs: retryAfterSeconds * 1_000,
    routeDecision: decision,
    error: createErrorEnvelope('too_many_requests', 'processing_overloaded', {
      reason,
      queueSize: limiter.queueSize,
      inflight: limiter.inflightCount,
      capacity: limiter.capacity,
    }),
  };
  processingOverloadCounter.add(1, { reason });
  pushAudit(
    ctx,
    'ics.referral.backpressure',
    {
      reason,
      queueSize: limiter.queueSize,
      inflight: limiter.inflightCount,
      capacity: limiter.capacity,
    },
    ctx.correlationId,
  );
}

function releaseProcessing(ctx: IcsContext): void {
  const release = ctx.processingRelease;
  if (!release) return;
  try {
    release();
  } catch (error) {
    logger.error('ics.backpressure.release_failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ctx.processingRelease = null;
  }
}

export class AckedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Acked');
  }

  async handle(_ctx: IcsContext, _event: IcsEvent): Promise<string> {
    releaseProcessing(_ctx);
    return 'Acked';
  }
}

function pushAudit(
  ctx: IcsContext,
  type: string,
  details: Record<string, unknown>,
  correlationId?: string,
  timestampProvider: () => number = Date.now,
): void {
  const stamp = new Date(timestampProvider()).toISOString();
  const event: AuditEvent = {
    type,
    ts: stamp,
    correlationId: correlationId ?? null,
    actorRef: null,
    subjectRef: null,
    outcome: null,
    reasonCode: null,
    details,
  };
  ctx.auditIntents?.push(event);
  ctx.auditSpool?.enqueue(event, correlationId ?? undefined);
}

function deriveAckIdempotencyKey(ctx: IcsContext, destinationOrgId: string): string {
  if (ctx.ackPublishIdempotencyKey) {
    return ctx.ackPublishIdempotencyKey;
  }
  const referralId = ctx.referral?.referralId ?? 'unknown-referral';
  const envelopeId = ctx.referralEnvelope?.id ?? 'unknown-envelope';
  const orgId = destinationOrgId?.trim().length ? destinationOrgId : 'unknown-org';
  return `ics:ack:${orgId}:${referralId}:${envelopeId}`;
}

export function initialiseIcsContext(
  ctx: IcsContext,
  deps: { auditSpool?: AuditSpool; processingLimiter?: ProcessingLimiter },
): IcsContext {
  if (deps.auditSpool) {
    ctx.auditSpool = deps.auditSpool;
  }
  if (deps.processingLimiter) {
    ctx.processingLimiter = deps.processingLimiter;
  }
  return ctx;
}
