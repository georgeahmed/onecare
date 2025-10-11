import { describe, it, expect } from 'vitest';
import { buildRouteDecision, RoutingConfig, ReferralRequest } from '../src/application/routing';

const cfg: RoutingConfig = {
  defaultOrgId: 'ORG-DEFAULT',
  byServiceCode: { '1111': 'ORG-SVC', '2222': 'ORG-SVC-2' },
  byDestinationHint: { 'hub-east': 'ORG-EAST' },
};

describe('ICS routing decision', () => {
  it('uses destination hint when present', () => {
    const req: ReferralRequest = { requestId: 'r1', destinationHint: 'hub-east' };
    const d = buildRouteDecision(req, cfg);
    expect(d.destinationOrgId).toBe('ORG-EAST');
    expect(d.policy).toBe('hint');
  });

  it('falls back to service code mapping when hint absent', () => {
    const req: ReferralRequest = { requestId: 'r2', serviceCode: '1111' };
    const d = buildRouteDecision(req, cfg);
    expect(d.destinationOrgId).toBe('ORG-SVC');
    expect(d.policy).toBe('serviceCode');
  });

  it('uses default when no mapping available', () => {
    const req: ReferralRequest = { requestId: 'r3', serviceCode: '9999' };
    const d = buildRouteDecision(req, cfg);
    expect(d.destinationOrgId).toBe('ORG-DEFAULT');
    expect(d.policy).toBe('default');
  });
});

