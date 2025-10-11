Task: SRE-01.2 — Secrets management baseline (templates, rotation policy)

Context
- Ensure no secrets in git and provide a clear pattern for local/dev secrets and rotation.

Files
- .env.example
- docs/SECURITY.md

Steps
1) Audit repo to ensure no secrets are committed; add pre-commit guidance.
2) Expand `.env.example` with placeholders for NATS creds, FHIR tokens, and OTEL endpoints.
3) Document rotation policy and storage location (e.g., Vault/secrets manager) in `docs/SECURITY.md`.

Acceptance Criteria
- No secrets in git; templates and docs cover needed variables and rotation.

Validate
- Static scan and code review; verify `.env.example` completeness.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.2' && make team-status-write

