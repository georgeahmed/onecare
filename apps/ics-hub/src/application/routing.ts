export interface ReferralRequest {
  requestId: string;
  serviceCode?: string; // e.g., SNOMED or local routing code
  destinationHint?: string; // optional hint
  patientId?: string;
}

export interface RoutingConfig {
  defaultOrgId: string;
  byServiceCode?: Record<string, string>;
  byDestinationHint?: Record<string, string>;
}

export interface RouteDecision {
  destinationOrgId: string;
  policy: string;
  rationale: string;
}

export function buildRouteDecision(req: ReferralRequest, cfg: RoutingConfig): RouteDecision {
  // Try explicit hint mapping first
  if (req.destinationHint && cfg.byDestinationHint?.[req.destinationHint]) {
    const org = cfg.byDestinationHint[req.destinationHint];
    return {
      destinationOrgId: org,
      policy: 'hint',
      rationale: `mapped by destination hint ${req.destinationHint}`,
    };
  }
  // Then service code mapping
  if (req.serviceCode && cfg.byServiceCode?.[req.serviceCode]) {
    const org = cfg.byServiceCode[req.serviceCode];
    return {
      destinationOrgId: org,
      policy: 'serviceCode',
      rationale: `mapped by service code ${req.serviceCode}`,
    };
  }
  // Fallback default
  return {
    destinationOrgId: cfg.defaultOrgId,
    policy: 'default',
    rationale: 'no specific mapping found; using default',
  };
}

