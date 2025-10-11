Task: SRE-01.6 — OTEL collector in compose; export to stdout/OTLP (dev)

Context
- Stand up an OpenTelemetry Collector in docker-compose to receive OTLP traces/metrics/logs from services and export to console or a local backend.

Files
- docker-compose.yml
- apps/*/.env.example (OTEL_EXPORTER_OTLP_ENDPOINT)
- docs/USAGE.md (observability)

Steps
1) Add `otel-collector` service with a minimal config to receive OTLP gRPC/HTTP on 4317/4318 and export to logging stdout; mount config from repo.
2) Wire apps to send OTLP to the collector using `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` (HTTP) and enable basic resources (service.name, env).
3) Document how to enable/disable OTEL in dev and how to tail collector logs to see spans/metrics.

Acceptance Criteria
- Collector runs via compose; apps export spans/metrics; logs visible in collector output.

Validate
- docker-compose up; perform a request; observe spans/metrics in collector logs.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-01 TASK='SRE-01.6' && make team-status-write

