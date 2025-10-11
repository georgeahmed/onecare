Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.6.md) | [Next](SRE-01.8.md)

Task: SRE-01.7 — TLS for bus + services in dev/prod parity (self‑signed in dev)

Context
- Enable TLS for NATS and service communication to reduce drift between dev and prod and validate cert handling.

Files
- docker-compose.yml
- docs/SECURITY.md (TLS guidance)

Steps
1) Generate self‑signed certs for dev (scripted) and mount into NATS and services; configure NATS to require TLS and clients to verify.
2) Provide env flags to toggle TLS in dev; document certificate paths and trust setup.
3) Document production expectations (managed certs, cert-manager) and how services validate certs.

Acceptance Criteria
- Dev stack can run with TLS on; services connect successfully; guidance documented.

Validate
- docker-compose up with TLS flags; confirm successful connections.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.7' && make team-status-write

