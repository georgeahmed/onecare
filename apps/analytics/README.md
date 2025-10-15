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
- Recommended schedule: add a cron entry (e.g., `0 1 * * * npm run metrics:rollup -- --date $(date -I)`) or equivalent scheduler task once deployment cadence is confirmed.

Quality Checks
- Run `npm run metrics:quality` (or `node scripts/analytics_quality.js`) to generate a markdown report highlighting missing fields and numeric outliers. Configure via `ANALYTICS_QUALITY_ZSCORE`, `ANALYTICS_SINK_PATH`, and `ANALYTICS_QUALITY_REPORT` or CLI flags (`--input`, `--output`, `--zscore`).
- Set `ANALYTICS_QUALITY_QUARANTINE` (or `--quarantine`) to capture quarantined records as NDJSON for follow-up triage.
