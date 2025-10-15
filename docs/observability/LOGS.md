# Centralised Logging

The compose environment now ships a lightweight Loki stack so engineers can explore structured logs with correlation IDs and retention rules that mirror production guardrails.

## Stack Overview

| Component | Purpose | Location |
|-----------|---------|----------|
| Loki | Stores log streams with 15‑day retention and low-cardinality indexes | `docker-compose.yml` (`loki` service), `infra/logs/loki-config.yaml` |
| Promtail | Ships container logs into Loki, extracting `correlationId`, `level`, and `service` labels | `infra/logs/promtail-config.yaml` |
| Grafana | Provides canned data sources for Loki and Prometheus | `infra/logs/grafana-provisioning/datasources/datasources.yaml` |

Bring the stack up with `docker compose up loki promtail grafana` (or `docker compose up` for the whole environment) and browse Grafana on `http://localhost:3000` (default credentials: `admin` / `admin`).

## Correlation-Friendly Format

Promtail reads the JSON logs emitted by `@onecare/observability`. The pipeline:

1. Parses Docker JSON log envelopes.
2. Extracts and labels `correlationId`, `level`, and `service`.
3. Uses the event timestamp as the Loki log timestamp.

Query for a correlation ID:

```
{job="container-logs", correlationId="corr-123"} |= "scribe"
```

Because the logger redacts PHI/PII by default, the stack is safe for dev usage. Never ship production PHI to the dev stack; keep production Loki/Grafana behind hardened auth.

## Retention & Cardinality

Loki is configured with filesystem storage and 15 days of retention (`infra/logs/loki-config.yaml`). Avoid adding unbounded label values—stick to route names, service names, or outcome enums. Correlation IDs already exist as labels so traces/metrics can pivot across telemetry.

If you need longer retention, switch to an object store (S3/GCS/Azure Blob) and expand `shared_store`. Update `limits_config` to enforce the desired rate/burst caps before widening retention.
