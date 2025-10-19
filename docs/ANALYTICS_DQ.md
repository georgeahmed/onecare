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

Threshold Catalogue
-------------------

| Metric | Check | Threshold | Action |
|--------|-------|-----------|--------|
| `latency_ms` | Numeric outlier | Z-score > 3 or raw value > 10 000 | Quarantine record; investigate producer latency or timestamp skew |
| `errors_total` | Missing labels | `labels.service` absent | Reject, update producer instrumentation, backfill via playback/backfill |
| `requests_total` | Missing numeric `value` | Non-numeric (NaN/empty) | Reject and fix producer type coercion |
| Any metric | Missing `name` | Schema validation failure | Block at ingress; raise incident with producing team |
| Any metric | Ingest lag | `analytics.ingest.lag_ms` p95 > 5 s for >10 min | Treat as pipeline incident; examine bus backpressure |

Remediation Playbook
--------------------

1. **Identify** — Use `analytics.ingest.*` counters and quality reports to isolate impacted metrics.
2. **Isolate** — Filter the quarantine NDJSON by `reason` to understand the failure class quickly.
3. **Fix** — Patch the upstream producer (labels/value types) or adjust metric throttles.
4. **Replay** — After remediation, run the playback or backfill tooling to restore gaps.
5. **Verify** — Re-run `npm run metrics:quality` and confirm the quarantine file is empty before closing.

Automation Cadence
------------------

- **Daily** — Schedule `npm run metrics:quality` followed by `npm run analytics:quarantine:export`.
- **Weekly** — Review reports, sanity-check quarantine counts, and update dashboards with new anomaly classes.
- **Monthly** — Align quarantine/export counts with retention reports to ensure archives match expectations.

Follow-ups
----------
- Wire the quality + export commands into CI/cron once the retention target, archive mount, and secrets are finalised.
- Automate periodic runs so reports and quarantine artefacts stay fresh without manual intervention.
