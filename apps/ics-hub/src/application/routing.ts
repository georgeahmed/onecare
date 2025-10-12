import type { IcsReferralRequest } from '@onecare/events';

export interface RoutingConfig {
  defaultDestinationOrgId?: string;
  orgOverrides?: Record<string, string>;
}

export interface RouteDecision {
  destinationOrgId: string;
  policy: 'org' | 'default' | 'fallback';
  rationale: string;
}

function normaliseKey(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normaliseValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface NormalisedRoutingConfig {
  defaultDestinationOrgId?: string;
  orgOverrides: Map<string, string>;
}

function normaliseConfig(config: RoutingConfig = {}): NormalisedRoutingConfig {
  const overrides = new Map<string, string>();
  if (config.orgOverrides) {
    for (const [key, destination] of Object.entries(config.orgOverrides)) {
      const normalisedKey = normaliseKey(key);
      const normalisedDestination = normaliseValue(destination);
      if (!normalisedKey || !normalisedDestination) continue;
      overrides.set(normalisedKey, normalisedDestination);
    }
  }
  const defaultDestination = normaliseValue(config.defaultDestinationOrgId);
  return {
    defaultDestinationOrgId: defaultDestination,
    orgOverrides: overrides,
  };
}

function deriveFallback(org: string): RouteDecision {
  const trimmed = org.trim();
  const destinationOrgId = trimmed.length > 0 ? trimmed : 'unknown';
  return {
    destinationOrgId,
    policy: 'fallback',
    rationale: 'no routing override or default configured; using incoming organisation identifier',
  };
}

export function buildRouteDecision(request: IcsReferralRequest, config: RoutingConfig = {}): RouteDecision {
  const normalisedOrg = normaliseKey(request.org);
  if (!normalisedOrg) {
    return {
      destinationOrgId: 'unknown',
      policy: 'fallback',
      rationale: 'organisation identifier missing; using placeholder destination',
    };
  }

  const normalisedConfig = normaliseConfig(config);
  const override = normalisedConfig.orgOverrides.get(normalisedOrg);
  if (override) {
    return {
      destinationOrgId: override,
      policy: 'org',
      rationale: `matched routing override for organisation ${request.org}`,
    };
  }

  if (normalisedConfig.defaultDestinationOrgId) {
    return {
      destinationOrgId: normalisedConfig.defaultDestinationOrgId,
      policy: 'default',
      rationale: 'no organisation override; using configured default destination',
    };
  }

  return deriveFallback(request.org);
}
