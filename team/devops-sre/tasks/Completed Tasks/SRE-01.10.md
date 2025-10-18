Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-01.1.md) | [Next](SRE-01.11.md)

Task: SRE-01.10 — Observability stack: OTEL, Prometheus/Grafana, logs (correlationId)

Context
- Provide a full dev observability loop: OTEL collector, Prometheus scraping, Grafana dashboards, and structured logs with correlationId threading.
- Current state: `docker-compose.yml` already ships OTEL Collector, Prometheus, Loki, and Grafana, and services emit structured JSON logs via `@onecare/observability`; however there are no pre-provisioned dashboards, no top-level observability doc, and metrics ↔ trace correlations are undocumented.

Files
- docker-compose.yml (Prometheus, Grafana, Loki, OTEL)
- infra/monitoring/prometheus.yml
- infra/logs/grafana-provisioning/datasources
- infra/logs/grafana-provisioning/dashboards (new)
- docs/observability/*
- docs/OBSERVABILITY.md (new index)

Steps
1) Pre-provision Grafana dashboards (JSON) for orchestrator, analytics, booking, and safety gate flows; wire Loki + Prometheus datasources so correlationId pivots work out-of-the-box.
2) Expose OTEL metrics that carry correlation metadata (e.g., span links or exemplars) and document how to jump between traces, metrics, and logs; update exporter/instrumentation as needed.
3) Author a top-level `docs/OBSERVABILITY.md` that summarizes the stack, links into the existing `docs/observability/` guides, and captures label/cardinality guardrails.

Acceptance Criteria
- Dashboards render without manual import; metrics + traces share correlation context; top-level documentation published.

Validate
- `docker compose up`; generate sample traffic; verify dashboards, Tempo/trace views, and Loki queries pivot via correlationId.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.10' && make team-status-write
