import { describe, it, expect } from 'vitest';
import { buildRouteDecision, type RoutingConfig } from '../src/application/routing';
import type { IcsReferralRequest } from '@onecare/events';

const baseRequest: IcsReferralRequest = {
  referralId: 'ref-1',
  patientId: 'patient-1',
  org: 'Org-Alpha',
  reason: 'demo',
};

describe('ICS routing decision', () => {
  it('routes using organisation override (case-insensitive match)', () => {
    const cfg: RoutingConfig = {
      orgOverrides: {
        'org-alpha': 'dest-1',
      },
    };

    const decision = buildRouteDecision(baseRequest, cfg);

    expect(decision.destinationOrgId).toBe('dest-1');
    expect(decision.policy).toBe('org');
    expect(decision.rationale).toContain('organisation');
  });

  it('falls back to default destination when override missing', () => {
    const cfg: RoutingConfig = {
      defaultDestinationOrgId: 'default-dest',
    };

    const decision = buildRouteDecision(baseRequest, cfg);

    expect(decision.destinationOrgId).toBe('default-dest');
    expect(decision.policy).toBe('default');
  });

  it('falls back to incoming organisation when no overrides or default configured', () => {
    const decision = buildRouteDecision(baseRequest);

    expect(decision.destinationOrgId).toBe('Org-Alpha');
    expect(decision.policy).toBe('fallback');
  });
});
