Analytics Data Quality
======================

Scope
-----
- Define the lightweight data-quality checks that gate `analytics.metric` ingestion and document how to act on violations.
- Covers the node consumer (`apps/analytics/src/consumer.ts`) and associated offline tooling (`scripts/analytics_quality.js`).

Runtime Guardrails
------------------
- **Schema validation:** every envelope is validated against `schemas/analytics/metric.json` before it reaches the sink. Invalid payloads are dropped, logged, and routed to `Topics.broker.deadLetter` with `cause = analytics.metric.validation_failed`.
- **Label sanitisation:** only allowlisted labels (`service`, `topic`, `status`, `outcomeCode`, `result`, `source`) survive ingestion. Values are trimmed, capped at 120 chars, and redacted when they resemble emails, access tokens, or phone numbers.
- **Persistence retries:** sink writes retry up to three times with exponential backoff + jitter. Failures after the retry budget land on the DLQ with `cause = analytics.metric.persistence_failed`.

Quarantine Workflow
-------------------
- Run `npm run metrics:quality` (or `node scripts/analytics_quality.js`) to audit historical data.
- Configure paths via:
  - `ANALYTICS_SINK_PATH` – source JSONL (defaults to `var/analytics/metrics.jsonl`)
  - `ANALYTICS_QUALITY_REPORT` or `--output` – markdown summary
  - `ANALYTICS_QUALITY_QUARANTINE` or `--quarantine` – NDJSON quarantine file (defaults to `var/analytics/quarantine.jsonl`)
  - `ANALYTICS_QUALITY_ZSCORE` or `--zscore` – numeric outlier threshold (default `3`)
- Quarantine entries contain a `reason` (`missing_name`, `missing_numeric_value`, `numeric_outlier`) and the offending record. Review the NDJSON output, remediate at the source, and replay via the analytics playback/backfill flow when available.

Archive Automation
------------------
- Execute `npm run analytics:quarantine:export` (or `node scripts/analytics_quarantine_export.js`) after each quality run to gzip the NDJSON and ship it to archival storage.
- Environment/CLI options:
  - `ANALYTICS_QUARANTINE_ARCHIVE_DIR` / `--archive`: destination root (mount or synced object-store path). Defaults to `var/analytics/archive`.
  - `ANALYTICS_QUARANTINE_RETENTION_DAYS` / `--retention-days`: optional retention window for archived payloads; files older than the window are pruned.
  - `ANALYTICS_QUARANTINE_DELETE_SOURCE` / `--delete-source`: remove the local NDJSON once the archive copy succeeds.
- Outputs are timestamped and grouped under `YYYY/MM/DD/analytics-quarantine-<timestamp>.jsonl.gz` for simple lifecycle management.
- Recommended workflow: schedule the quality script, then invoke the export script; ensure the archive directory is backed by the agreed cold-storage tier once retention targets are finalised.

Follow-ups
----------
- Wire the quality + export commands into CI/cron once the retention target, archive mount, and secrets are finalised.
- Automate periodic runs so reports and quarantine artefacts stay fresh without manual intervention.
