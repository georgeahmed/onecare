# Egress & SSRF Protection Policy

Last updated: 2025-10-18  
Owners: Security, DevOps SRE, Backend Integrations

## Goals

- Control outbound network traffic from OneCare services.
- Prevent Server-Side Request Forgery (SSRF) attacks and unintended data exfiltration.

## Egress Allowlisting

- All outbound destinations must be explicitly approved. Maintain environment-specific allowlists via Kubernetes NetworkPolicies (`infra/k8s/networkpolicies/`) and service configuration.
- Deny traffic to private IP ranges, link-local addresses, metadata services (`169.254.169.254`), and loopback unless explicitly required.
- Partners requesting egress access must provide hostname, purpose, data classification, and retention requirements. Review quarterly.

## Application Guardrails

- Use canonical URL validation helpers that:
  - Parse and validate scheme (`https` preferred), host, and port.
  - Resolve DNS and ensure resulting IP is not private/loopback unless allowlisted.
  - Enforce maximum timeouts and restrict headers to minimum required.
- For dynamic callbacks (webhooks), store allowlisted endpoints in config; do not accept arbitrary URLs from user input.
- Always use TLS (see `TLS_POLICY.md`) and pin certificates for high-risk partners.
- Strip or redact sensitive headers before forwarding responses into logs.

## Proxy & Observability

- Consider central egress proxy for additional logging and threat detection (tracked under `SRE-TRACK-230`).
- Monitor egress metrics (`egress.deny_total`, NetworkPolicy violations) and alert on anomalies.

## Testing & Validation

- CI Semgrep rules enforce safe URL usage (no direct `http.get` without validation).
- DAST scans (OWASP ZAP) include SSRF probe endpoints when safe.
- Unit tests should cover allow/deny cases for URL validation helpers.

## References

- `docs/security/APPLICATION_SECURITY.md` — SAST ruleset.
- `infra/k8s/networkpolicies/` — default deny policies and allowlist examples.
- `docs/security/TLS_POLICY.md` — TLS requirements for outbound calls.
