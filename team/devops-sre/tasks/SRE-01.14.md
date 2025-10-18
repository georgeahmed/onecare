Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.13.md) | [Next](SRE-01.15.md)

Task: SRE-01.14 — Backup/restore verification + DR (scheduled backups, test restores, RTO/RPO)

Context
- Turn backup scripts into a scheduled, verified DR plan with RTO/RPO targets.
- Current state: `scripts/ops/backup.sh` and `restore.sh` create manual snapshots; `docs/RUNBOOKS.md` documents ad-hoc usage but lacks schedules, automation, or explicit RTO/RPO targets.

Files
- scripts/ops/backup.sh, restore.sh (extend)
- docs/RUNBOOKS.md (DR section)

Steps
1) Automate backups (cronjob/CI workflow) wrapping the existing scripts, store artefacts off-cluster with retention metadata, and log success/failure to observability stack.
2) Implement periodic restore drills (staging namespace or sandbox cluster) that exercise the scripts end-to-end and capture recovery timings.
3) Document RTO/RPO targets per scenario (broker loss, PV loss, region outage) in `docs/RUNBOOKS.md`, along with validation checklist and escalation plan for failures.

Acceptance Criteria
- Backups automated; restores tested; RTO/RPO documented; gaps identified.

Validate
- Perform a scheduled test restore; record timings; update runbook.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.14' && make team-status-write
