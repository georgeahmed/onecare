Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.8.md) | [Next](SRE-02.1.md)

Task: SRE-01.9 — Data retention/minimization: log/event retention policies + purge tooling

Context
- Enforce retention and minimization policies for logs and DLQ messages; provide operator tooling to purge data safely.

Files
- docs/SECURITY.md (retention policy)
- scripts/ops/purge-dlq.sh (new)
- scripts/ops/purge-logs.sh (new)

Steps
1) Document retention periods for logs and DLQ artifacts (e.g., 14/30 days) and data minimization rules.
2) Add purge scripts that safely archive and delete items older than retention, with dry-run mode.
3) Ensure DLQ reprocessing notes include guidance to purge post-successful replay.

Acceptance Criteria
- Retention policy documented; purge scripts exist with dry-run; operators can purge DLQ/logs safely.

Validate
- Create mock DLQ/log artifacts and run purge scripts in dry-run and real modes; verify behavior.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.9' && make team-status-write

