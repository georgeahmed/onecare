Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.5.md) | [Next](SEC-02.7.md)

Task: SEC-02.6 — Secrets policy & rotation SLAs

Context
- Define secrets taxonomy, storage, rotation cadences, and verification procedures; prohibit secrets in git.

Files
- docs/security/SECRETS_POLICY.md (new)

Steps
1) Classify secrets (tokens, keys, certs); assign owners; set rotation SLAs (e.g., 90 days for tokens, 1y for certs) and emergency rotation steps.
2) Define storage (Vault/KMS) and retrieval mechanisms (env injectors/sidecars); audit and access review cadence.
3) Document verification: post-rotation smoke tests and monitoring hooks.

Acceptance Criteria
- Policy published; rotation SLAs defined; verification steps documented.

Validate
- Tabletop rotation; confirm monitoring signals.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.6' && make team-status-write

