Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.5.md) | [Next](SRE-02.7.md)

Task: SRE-02.6 — Centralized logs stack (Loki/ELK) with correlationId parsing and retention

Context
- Aggregate structured JSON logs centrally; parse correlationId; set retention; and document queries.

Files
- docker-compose.yml (optional Loki stack)
- docs/observability/LOGS.md (new)

Steps
1) Add a lightweight logs stack (Loki + Promtail + Grafana) in compose or document ELK integration.
2) Ensure `correlationId` is parsed into a label/field; provide example queries.
3) Set retention policies; document cost implications and best practices (avoid high-cardinality labels).

Implementation Notes
- `docker-compose.yml` now provisions Loki, Promtail, Prometheus, and Grafana for local tele‑metry triage.
- Configuration lives under `infra/logs/` (Loki, Promtail, Grafana provisioning) with retention tuned to 15 days.
- Operator guidance and correlation ID queries are documented in `docs/observability/LOGS.md`.

Acceptance Criteria
- Logs visible centrally with correlationId filters; retention documented.

Validate
- Compose up; generate logs; query in Grafana or ELK.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.6' && make team-status-write
