Task: SRE-01.10 — Observability stack: OTEL, Prometheus/Grafana, logs (correlationId)

Context
- Provide a full dev observability loop: OTEL collector, Prometheus scraping, Grafana dashboards, and structured logs with correlationId threading.

Files
- docker-compose.yml (prometheus, grafana)
- docs/OBSERVABILITY.md (new)

Steps
1) Add Prometheus and Grafana services to compose; configure Prometheus to scrape /metrics endpoints; pre‑load sample dashboards for services.
2) Ensure logs are structured JSON; document how to parse correlationId in queries (if using Loki/ELK later).
3) Link OTel spans to metrics where possible; document labels and cardinality guidance.

Acceptance Criteria
- Prom/Grafana up; metrics visible; dashboards load; logs show correlationId.

Validate
- docker-compose up; open Grafana; view dashboards after sample traffic.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.10' && make team-status-write

