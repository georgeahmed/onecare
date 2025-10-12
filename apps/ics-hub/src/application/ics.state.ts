import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { IcsClient } from '../adapters/ics.client';
import type { IcsOrganisationPolicy, ResolvedConfig } from '@onecare/config';
import { getIcsOrganisationPolicies } from '@onecare/config';
import { createCounter, logger } from '@onecare/observability';

const routingDecisionCounter = createCounter('ics.routing.decisions_total');
const routingBlockedCounter = createCounter('ics.routing.blocked_total');
const routingRateLimitedCounter = createCounter('ics.routing.rate_limited_total');

const RATE_WINDOW_MS = 60_000;

function normaliseOrgId(orgId: string): string {
  return orgId.trim().toLowerCase();
}

class TokenBucketLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(private limit?: number) {}

  updateLimit(limit?: number): void {
    this.limit = limit;
    if (!limit || limit <= 0) {
      this.windowStart = 0;
      this.count = 0;
    } else if (this.count > limit) {
      this.count = limit;
    }
  }

  tryConsume(now = Date.now()): boolean {
    if (!this.limit || this.limit <= 0) {
      return true;
    }
    if (this.windowStart === 0 || now - this.windowStart >= RATE_WINDOW_MS) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      return false;
    }
    this.count += 1;
    return true;
  }
}

export interface IcsContext extends MachineContext {
  client?: IcsClient;
  organisationId?: string;
  claim?: unknown;
  correlationId?: string;
  blocked?: boolean;
  rateLimited?: boolean;
  routePolicy?: IcsOrganisationPolicy;
}

export interface IcsEvent extends MachineEvent {
  type: 'ics.route' | string;
}

type OrgPolicyMap = Record<string, IcsOrganisationPolicy>;

export class InboundState extends BaseState<IcsContext, IcsEvent> {
  private readonly policies = new Map<string, IcsOrganisationPolicy>();
  private readonly limiters = new Map<string, TokenBucketLimiter>();

  constructor(policies: OrgPolicyMap = {}) {
    super('Inbound');
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
      this.limiters.set(normalised, new TokenBucketLimiter(policy.rateLimit));
    }
  }

  private getLimiter(orgId: string, policy: IcsOrganisationPolicy): TokenBucketLimiter {
    let limiter = this.limiters.get(orgId);
    if (!limiter) {
      limiter = new TokenBucketLimiter(policy.rateLimit);
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
    const allowed = limiter.tryConsume();
    if (!allowed) {
      ctx.blocked = false;
      ctx.rateLimited = true;
      ctx.routePolicy = policy;
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
      return 'Blocked';
    }
    if (ctx.rateLimited) {
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

export class AckedState extends BaseState<IcsContext, IcsEvent> {
  constructor() {
    super('Acked');
  }

  async handle(_ctx: IcsContext, _event: IcsEvent): Promise<string> {
    return 'Acked';
  }
}
