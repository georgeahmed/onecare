Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.4.md) | [Next](SRE-01.6.md)

Task: SRE-01.5 — Backup/restore stub scripts + runbook

Context
- Provide basic backup/restore procedures for critical state (e.g., JetStream, configs) and document recovery steps.

Files
- scripts/ops/backup.sh (new)
- scripts/ops/restore.sh (new)
- docs/RUNBOOKS.md (new)

Steps
1) Add stub scripts to snapshot NATS JetStream state (if applicable) and config files to a local folder.
2) Document restore flow and downtime expectations in `docs/RUNBOOKS.md`.

Acceptance Criteria
- Backup/restore scripts exist; runbook describes operator steps.

Validate
- Run backup scripts locally; verify artifacts created; simulate restore procedure in dev.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.5' && make team-status-write

