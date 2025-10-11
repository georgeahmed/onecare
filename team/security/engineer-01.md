Engineer: Security 01

Role: Security Engineer (App/Platform Security)
Stack: Policy, TypeScript, Python, CI/CD

Responsibilities
- Logging and telemetry redaction (no PHI/PII/secrets), authZ matrix, threat modeling, secrets policy, and security docs.
- Partner with SRE on supply chain security, CI gates, TLS/creds, and retention/minimization.

Initial Tasks
- SEC-01.1 — Logging redaction utility
- SEC-01.2 — AuthZ matrix documentation (scopes/actions)

Start Here
- AGENTS.md — Security & Privacy Checklist
- docs/SECURITY.md, docs/SECURITY_AUTHZ.md (to be created/updated)
- packages/observability/src/logger.ts (redaction)

Status: stable
Progress: 100%

Dependencies
- devops-sre/engineer-01..02 (CI, observability backends, secrets/TLS)
- backend/engineer-01 (Error envelope taxonomy & redaction usage)

Platform Checklist (pre-flight)
- CI gates for SBOM/vuln scans in place; log format policy defined; correlationId propagated.
- Redaction utility present and applied; no PHI/PII or secrets in logs.
- AuthZ matrix documented and referenced by services; deny-by-default posture enforced.

Tasks
- [x] SEC-01.1 — Logging redaction utility
- [x] SEC-01.2 — AuthZ matrix documentation (scopes/actions)

