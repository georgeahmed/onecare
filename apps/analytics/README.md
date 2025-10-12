Analytics Sink

Purpose
- Persist `analytics.metric` payloads to a durable JSONL file for downstream ingestion.

Environment
- `ANALYTICS_SINK_PATH`: Optional override for the sink path. Defaults to `var/analytics/metrics.jsonl` relative to the repo root.

Consumer
- `startAnalyticsConsumer()` subscribes to `Topics.analytics.metric`, validates payloads against the schema, writes to the configured sink, and ships validation/persistence failures to the DLQ via thrown errors (`AnalyticsMetricValidationError`, `AnalyticsMetricSinkError`).

Docker
- Service name `analytics` is available in `docker-compose.yml`; metrics persist under the `analytics-metrics` volume at `/var/analytics/metrics.jsonl`.
- Health: relies on process liveness for now; add HTTP readiness once the deployment target requires active probes.

Rollups
- Run `npm run metrics:rollup` (or `node scripts/metrics_rollup.js`) to produce daily counts + p95 summaries under `var/analytics/rollup.jsonl`. Override input/output via `ANALYTICS_SINK_PATH`, `ANALYTICS_ROLLUP_PATH`, or CLI flags (`--input`, `--output`, `--date`).
