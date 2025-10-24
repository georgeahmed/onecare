# WAF, Rate Limiting, and DoS Mitigation Policy

Last updated: 2025-10-18  
Owners: DevOps SRE, Security

## Goals

Protect public-facing endpoints from abuse, bots, and denial-of-service attacks while respecting privacy and service quality.

## Traffic Classes

| Endpoint Type | Examples | Default Rate Limit | Notes |
|---------------|----------|--------------------|-------|
| Authentication | `/auth/*`, `/oauth/*` | 20 requests/min per IP + device fingerprint | Require captcha after repeated failures; log attempts with hashed identifiers. |
| Form Submission | `/safety-check`, `/booking/request` | 10 requests/min per IP | Burst handling via Access Gate; block after threshold for 15 minutes. |
| Static Content | Portal assets | CDN handles caching; minimal WAF rules | Ensure CSP & HSTS headers. |
| API (Clinician) | `/api/*` | 60 requests/min per API token | Include user ID + token fingerprint in rate key. |

Adjust limits based on load testing and clinical expectations; document overrides with expiry.

## WAF Rules

- Block known malicious IP ranges and bots (OWASP Core Rule Set baseline) with false-positive tuning.
- Enforce TLS 1.2+ only; redirect HTTP → HTTPS.
- Inspect for SQL injection, XSS, path traversal; log blocked requests with sanitized payload metadata (no PHI).
- Enable geo-blocking for regions not serving patients (if legal permits). Document exceptions.

## DoS Mitigation

- Use CDN (CloudFront/Azure Front Door) to absorb volumetric attacks.
- Autoscale ingress pods with sensible max replicas; protect backend with connection throttling.
- Implement connection timeouts and max request size on ingress (e.g., 500 KB for JSON payloads).
- Maintain runbook for scaling up resources and notifying partners during incident.

## Monitoring & Alerting

- Collect WAF and rate-limit metrics (`http_rate_limited_total`, `waf.blocked_total`).
- Alert thresholds (per env):
  - ≥100 blocked requests/min → WARN
  - ≥10 blocked requests/min sustained 15 minutes → investigate.
- Store WAF logs in privacy-aware storage (anonymized IPs via hashing).

## References

- NetworkPolicies: `infra/k8s/networkpolicies/`
- Secure SDLC: `docs/security/SECURE_SDLC.md`
- Incident response: `docs/security/INCIDENT_RESPONSE.md`
