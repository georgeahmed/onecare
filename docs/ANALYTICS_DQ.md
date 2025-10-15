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

Follow-ups
----------
- Extend the quarantine job to push directly to long-term object storage once retention policies are finalised.
- Automate periodic runs (cron / workflow) so reports and quarantine artefacts stay fresh without manual intervention.
