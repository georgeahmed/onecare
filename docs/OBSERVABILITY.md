# Observability Stack Overview

This repository ships a batteries-included observability toolkit so engineers can iterate locally with the same signals we expect in staging and production.

## Stack Components

| Signal | Tooling (dev) | Details |
|--------|---------------|---------|
| Logs | Loki + Promtail | JSON logs emitted via `@onecare/observability`, indexed with correlationId labels. See `infra/logs/*.yaml` and `docs/observability/LOGS.md`. |
| Metrics | Prometheus | Scrapes the OTEL collector and service exporters; curated dashboards capture latency, error rate, and DLQ depth. Configuration lives in `infra/monitoring/prometheus.yml`. |
| Traces | OpenTelemetry Collector | Node services export OTLP spans; the collector applies tail-sampling rules (errors, slow traces, probabilistic baseline). Details in `docs/observability/TRACING.md`. |

Bring everything up with `docker compose up otel-collector loki promtail prometheus grafana` (or `docker compose up` for the full stack). Grafana becomes available at `http://localhost:3000` (`admin/admin` by default).

## Dashboards

Grafana dashboards are provisioned automatically from `infra/logs/grafana-provisioning/dashboards/`:

- **Orchestrator Overview** (`orchestrator-overview.json`) — request latency (p50/p95), error rates, DLQ backlog, and bus reconnect counters.
- **Booking & Safety Gate** (`booking-safety.json`) — ingress latency, retry/timeout counters, safety outcomes.
- **Analytics & Pipeline Health** (`analytics-pipeline.json`) — consumer throughput, DLQ intake, and processing lag.

Each panel is wired for correlationId search so you can pivot from a log line to a trace or metric. Extend the dashboards by dropping additional JSON files in the same directory; they will be picked up on the next Grafana restart.

## Alerts

PrometheusRule definitions live in `infra/monitoring/alerts/` and are mirrored in `docs/observability/alerts/*.yaml` for template reference. The baseline rules cover:

- Orchestrator and booking latency burn-rate checks (warning + critical windows).
- Safety/analytics error budgets (error rate and DLQ growth).
- Readiness flap detection (consecutive readiness probe failures).

Run `promtool check rules infra/monitoring/alerts/*.yaml` before applying changes. When promoting to shared clusters, integrate these rules into your Prometheus Operator or cloud-managed alerting.

## SLOs & On-Call

Service-level objectives (latency, availability, error rate, DLQ backlog) are documented in `docs/observability/SLOs.md`. Alert hygiene, escalation flow, and runbook linkage live in `docs/observability/ALERTING.md`. Keep those documents in sync when thresholds change or new alerts are introduced.

## Local Workflow

1. `bash scripts/ops/generate-dev-certs.sh` (once) and `docker compose up`.
2. Generate load with `make stack-smoke` (fires `/safety-check` smoke requests end-to-end).
3. Inspect Grafana dashboards (`Orchestrator Overview`, `Booking & Safety`, `Analytics Pipeline`) and use Loki searches like `{correlationId="corr-123"}`.
4. Tail otel-collector logs for sampling decisions: `docker compose logs otel-collector`.
5. Adjust rules/dashboards → rerun `docker compose restart grafana prometheus`.
