Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.11.md) | [Next](SRE-01.13.md)

Task: SRE-01.12 — Secrets manager integration (Vault/KMS), sealed‑secrets, rotation runbook

Context
- Move beyond .env for sensitive values; integrate a secrets manager and define rotation procedures.
- Current state: services read secrets from process env (`.env`, GitHub secrets); no `infra/secrets/` scaffolding or rotation guidance exists.

Files
- docs/SECURITY.md (expand)
- infra/secrets/* (examples)
- .env.example, config/*

Steps
1) Choose a secrets manager (Vault/cloud KMS); document access policies and how apps retrieve secrets (env injectors/sidecars).
2) Provide examples for sealed‑secrets/GitOps safe storage; ensure no secrets in git.
3) Write a rotation runbook with steps, validation, and rollback; test in staging.

Acceptance Criteria
- Integration path documented; examples present; rotation runbook written.

Validate
- Tabletop rotation in staging; verify no downtime.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.12' && make team-status-write
