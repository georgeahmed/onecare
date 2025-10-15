Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](../SRE-01.9.md) | [Next](SRE-02.2.md)

Task: SRE-02.1 — Add OpenTelemetry Collector to compose (OTLP exporters)

Context
- Stand up a local OpenTelemetry Collector to receive traces/metrics/logs from services via OTLP. Provide a logging exporter by default and document how to wire other backends.

Files
- infra/otel/otel-collector.yaml (new)
- docker-compose.yml (add `otel-collector` service)
- docs/observability/COLLECTOR.md (new)

Steps
1) Create `infra/otel/otel-collector.yaml` with OTLP receivers (gRPC/HTTP) and a `logging` exporter; set sensible memory limits.
2) Add an `otel-collector` service to `docker-compose.yml` exposing OTLP ports and mounting the config.
3) Document how to configure exporters (e.g., Tempo/Prom/Grafana/Jaeger) via environment overrides in dev.

Acceptance Criteria
- Collector starts via compose; receives spans from Node services and prints summaries to logs.

Validate
- `docker-compose up -d` then generate traffic; confirm collector logs show received spans/metrics.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.1' && make team-status-write
