import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { IcsClient } from '../adapters/ics.client';
import type { IcsOrganisationPolicy, ResolvedConfig } from '@onecare/config';
import { getIcsOrganisationPolicies } from '@onecare/config';
import { createCounter, logger } from '@onecare/observability';
import type { ErrorEnvelope, ErrorObject } from '@onecare/events';

const routingDecisionCounter = createCounter('ics.routing.decisions_total');
const routingBlockedCounter = createCounter('ics.routing.blocked_total');
const routingRateLimitedCounter = createCounter('ics.routing.rate_limited_total');

const RATE_WINDOW_MS = 60_000;

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
    };

export interface IcsContext extends MachineContext {
  client?: IcsClient;
  organisationId?: string;
  claim?: unknown;
  correlationId?: string;
  blocked?: boolean;
  rateLimited?: boolean;
  routePolicy?: IcsOrganisationPolicy;
  routingOutcome?: RoutingOutcome;
}

export interface IcsEvent extends MachineEvent {
  type: 'ics.route' | string;
}

type OrgPolicyMap = Record<string, IcsOrganisationPolicy>;

interface InboundStateOptions {
  now?: () => number;
}

export class InboundState extends BaseState<IcsContext, IcsEvent> {
  private readonly policies = new Map<string, IcsOrganisationPolicy>();
  private readonly limiters = new Map<string, TokenBucketLimiter>();
  private readonly now: () => number;

  constructor(policies: OrgPolicyMap = {}, options: InboundStateOptions = {}) {
    super('Inbound');
    this.now = options.now ?? Date.now;
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
    if (!ctx.client) {
      throw new Error('ics_client_missing');
    }
    const requestedOrg = ctx.organisationId?.trim();
    if (!requestedOrg) {
      throw new Error('organisation_missing');
    }

    const correlationId = ctx.correlationId;
    const normalisedOrg = normaliseOrgId(requestedOrg);
    ctx.organisationId = normalisedOrg;

    const policy = this.policies.get(normalisedOrg);
    if (!policy) {
      ctx.blocked = true;
      ctx.rateLimited = false;
      ctx.routePolicy = undefined;
      ctx.routingOutcome = {
        status: 'forbidden',
        httpStatus: 403,
        error: buildErrorEnvelope(
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
        error: buildErrorEnvelope(
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
      logger.warn('ics.routing.rate_limited', {
        organisationId: normalisedOrg,
        correlationId,
        result: 'rate_limited',
        limitPerMinute: policy.rateLimit,
      });
      routingDecisionCounter.add(1, { outcome: 'rate_limited', organisationId: normalisedOrg });
      routingRateLimitedCounter.add(1, { organisationId: normalisedOrg });
      return 'Validated';
    }

    ctx.blocked = false;
    ctx.rateLimited = false;
    ctx.routePolicy = policy;
    ctx.routingOutcome = {
      status: 'allowed',
      policy,
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
    if (ctx.blocked) {
      ctx.routingOutcome ??= {
        status: 'forbidden',
        httpStatus: 403,
        error: buildErrorEnvelope('forbidden', 'organisation_not_allowed'),
      };
      return 'Blocked';
    }
    if (ctx.rateLimited) {
      ctx.routingOutcome ??= {
        status: 'rate_limited',
        httpStatus: 429,
        policy: ctx.routePolicy!,
        error: buildErrorEnvelope('too_many_requests', 'rate_limit_exceeded'),
      };
      return 'RateLimited';
    }
    if (!ctx.routePolicy) {
      throw new Error('route_policy_missing');
    }
    return 'Routed';
  }
}

export class RoutedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Routed');
  }

  async handle(_ctx: IcsContext, _event: IcsEvent): Promise<string> {
    return 'Acked';
  }
}

function buildErrorEnvelope(
  code: Extract<ErrorObject['code'], 'forbidden' | 'too_many_requests'>,
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string,
): ErrorEnvelope {
  const error: ErrorObject = {
    code,
    message,
    ...(details ? { details } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
  return { error };
}

export class AckedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Acked');
  }

  async handle(_ctx: IcsContext, _event: IcsEvent): Promise<string> {
    return 'Acked';
  }
}
