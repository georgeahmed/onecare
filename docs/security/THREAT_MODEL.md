# Threat Model & Data Flow

Last updated: 2025-10-18  
Owners: Security (primary), DevOps SRE, Backend Integrations

Stakeholder review completed 2025-10-18 with representatives from SRE, Data Engineering, and Integrations (see notes in `docs/security/dpia-records/telephony-parity.md`). Future revisions should repeat the triad review before sign-off.

## Scope

The threat model covers the end-to-end OneCare platform across the following surfaces:

- Patient- and clinician-facing clients (portal web app, telephony IVR).
- Orchestrator service (HTTP ingress, event emission, FHIR/object store adapters).
- Booking service (GP Connect integration, FHIR write-back).
- ICS Hub (referral ingestion, automation tasks, DLQ publishing).
- Ambient/ML services (Safety Gate, Scribe, analytics feature store).
- Shared infrastructure: NATS JetStream, Redis/Idempotency, object storage, Vault, Kubernetes control plane.

## Data Flow Diagram

![OneCare Data Flow](DFD.png)

Legend:

1. Patients submit issues via the portal or telephony. Traffic terminates at the ingress controller (TLS) and reaches the orchestrator.
2. Orchestrator validates payloads, calls Safety Gate (ML) and writes to FHIR/Object Store, emitting events on NATS. Booking, ICS Hub, analytics consumers subscribe to the bus.
3. Booking integrates with GP Connect (outbound HTTPS + mTLS), updates FHIR, and produces audit events. ICS Hub routes referrals to partner endpoints (mTLS) and automation tasks back onto the bus.
4. Observability pipeline (OTEL) exports traces/logs to the collector; audit/analytics stores receive sanitized metadata.
5. Vault issues short-lived credentials to workloads; cert-manager handles TLS certificates.

See `docs/security/DATA_CLASSIFICATION.md` for the data handling and retention overlay on the flows above.

## STRIDE Analysis

| Component / Flow | Spoofing | Tampering | Repudiation | Information Disclosure | Denial of Service | Elevation of Privilege | Mitigations |
|------------------|----------|-----------|-------------|------------------------|-------------------|------------------------|-------------|
| Portal/Telephony ingress | Enforce OIDC login + device session; rate limits | TLS termination; WAF rules | Access logs with WORM retention | HTTPS, CSP, no PHI in client storage | CDN + rate limits (Access Gate) | Role-based scopes via OIDC | See Secure Coding + JWT hardening docs |
| Orchestrator ↔ Safety Gate | Service account impersonation | Payload tampering | Trace IDs logged | ML responses stripped of raw PHI | Timeout + retries; backpressure | None (no exec) | mTLS (pending), JSON schema validation, idempotency |
| Orchestrator ↔ GP Connect | Upstream identity spoof | Payload tamper / man-in-the-middle | Audit logs | PHI leakage | Rate limits from provider; retry budget | n/a | HTTPS + API key + mTLS (policy), conflict handling |
| Orchestrator → NATS bus | Publish spoofing | Message tamper | Envelope IDs logged | Sensitive fields hashed | DLQ + retry caps | Topic ACLs in NATS | withMessageGuards, DLQ retention policy |
| Booking service ↔ FHIR | Same as orchestrator | As above | Audit events | PHI redacted in logs | Guarded retries | n/a | FHIR auth tokens via Vault, response validation |
| ICS Hub ↔ partner endpoints | Partner impersonation | Payload tamper | Audit spool WORM | Pseudonymised referrals | Rate limiter | n/a | mTLS, routing allowlist, automation idempotency |
| Analytics / Feature store | Fake data injection | Metrics tamper | Signed audit entries | Use minimal datasets | Quotas; job SLAs | n/a | Data classification, anonymisation, SBOM |
| Vault / Secrets | Stolen tokens | Secret tampering | Vault audit log | Secret exposure | Vault HA | n/a | Sealed secrets, short TTL tokens, rotation runbook |
| Kubernetes control plane | Fake kubeconfig | Manifest tamper | Audit logs | Resource enumeration | Pod disruption | Privilege escalation | RBAC least privilege, NetworkPolicy defaults |

### Key Risks & Mitigations

1. **Spoofed upstream integration (GP Connect/ICS)**  
   - Mitigations: Enforce mTLS (see `docs/security/TLS_POLICY.md`), API key rotation, connection allowlists, correlation ID logging. **Follow-up:** file ticket `SRE-TRACK-217` (pending) to complete booking ↔ orchestrator mTLS rollout.
2. **JWT misuse / replay**  
   - Mitigations: Hardening guidance (`docs/security/OIDC_JWT_HARDENING.md`), short token TTLs, cache busting on logout, audience/issuer enforcement. **Follow-up:** `SEC-TRACK-142` to add automated replay/id checks in integrations test suites.
3. **PHI leakage via analytics/logs**  
   - Mitigations: Data classification & masking controls, `privacy_policy.retention_days` alignment, Trivy/CI guardrails, audit WORM storage (SEC-02.11). **Follow-up:** `DATA-TRACK-58`—validate warehouse TTL job once deployed.
4. **Configuration drift / credential leakage**  
   - Mitigations: Vault sealed secrets, pipeline scanning, SBOM signing, automated backups + rotation. **Follow-up:** `SRE-TRACK-223` to extend nightly backup verification to production cluster snapshots.

### Follow-up Actions / Tickets

- SRE-01.13: Apply NetworkPolicies & cert-manager manifests (in progress).
- SEC-02.4: Publish TLS/mTLS policy and enforce pinning for outbound clients.
- SEC-02.5: Implement comprehensive JWT verification tests across integrations.
- IR plan (SEC-02.10) to incorporate STRIDE findings (DoS playbooks, partner outages).

## Review & Updates

- Threat model reviewed with Security, SRE, and Backend on 2025-10-18; action items tracked in Jira board `SEC-2025-Q4`.
- Update cadence: quarterly or when introducing new external integrations / data stores.
- Please submit PRs for modifications and tag `@onecare/security` for review.
