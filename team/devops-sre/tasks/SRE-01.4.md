Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.3.md) | [Next](SRE-01.5.md)

Task: SRE-01.4 — Resource limits/requests; health/restart policy; ulimits

Context
- Avoid noisy neighbors and improve resilience by defining resources and restart policy.

Files
- docker-compose.yml
- docs/USAGE.md

Steps
1) Add cpu/memory limits for services; set restart policies to `unless-stopped` in dev compose.
2) Set ulimits as required (e.g., nofile) for NATS.
3) Document expected resource usage and tuning knobs in USAGE.

Acceptance Criteria
- Compose reflects resource constraints; services behave predictably under load.

Validate
- Run compose; simulate load; observe no OOM/storm restarts.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.4' && make team-status-write

