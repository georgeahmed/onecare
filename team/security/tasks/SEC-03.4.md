Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.3.md) | [Next](SEC-03.5.md)

Task: SEC-03.4 — Secrets prevention hooks (pre‑commit/pre‑receive)

Context
- Prevent accidental secret commits with local hooks and server‑side enforcement.

Files
- .pre-commit-config.yaml (extend)
- docs/security/SECRETS_PREVENTION.md (new)

Steps
1) Add pre‑commit hooks for secrets scanning (gitleaks/trufflehog) and block on high confidence matches.
2) Document enabling hooks for all contributors; provide suppression process for false positives.
3) Propose pre‑receive hook guidance for central repos (if applicable).

Acceptance Criteria
- Hooks available and documented; scanning enforced locally/CI.

Validate
- Simulate test secrets; observe block.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.4' && make team-status-write

