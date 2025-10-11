Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.7.md) | [Next](SRE-01.10.md)

Task: SRE-01.1 — Configure NATS (URL, creds) in compose; health probes; readiness gating

Context
- Provide a working message broker in local/dev with proper readiness checks and environment wiring for services.

Files
- docker-compose.yml
- apps/*/.env.example
- docs/USAGE.md

Steps
1) Add NATS service with JetStream enabled; expose client and monitor ports; configure volumes if needed.
2) Inject `NATS_URL` and credentials into orchestrator and workers via env.
3) Add basic health endpoint checks and wire orchestrator readiness to bus connectivity (documented in USAGE).

Acceptance Criteria
- `docker-compose up` brings NATS and orchestrator up; readiness reflects bus connectivity.

Validate
- `make docker-up` then curl orchestrator /health and /ready; observe readiness depends on bus.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.1' && make team-status-write

