Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.13.md) | [Next](SRE-01.15.md)

Task: SRE-01.14 — Backup/restore verification + DR (scheduled backups, test restores, RTO/RPO)

Context
- Turn backup scripts into a scheduled, verified DR plan with RTO/RPO targets.

Files
- scripts/ops/backup.sh, restore.sh (extend)
- docs/RUNBOOKS.md (DR section)

Steps
1) Schedule periodic backups of critical state (broker streams, configs); store off‑cluster with retention.
2) Run periodic restore tests in staging; measure time to recover; compare to RTO/RPO; adjust as needed.
3) Document DR scenarios and steps (broker loss, persistent volume loss, region outage) with expected timelines.

Acceptance Criteria
- Backups automated; restores tested; RTO/RPO documented; gaps identified.

Validate
- Perform a scheduled test restore; record timings; update runbook.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.14' && make team-status-write

