# Analytics Lineage Events

Analytics ETL scripts emit OpenLineage-style JSON events so governance systems can trace inputs, outputs, and
execution metadata across the pipeline. Events are appended as newline-delimited JSON to lineage logs that live
alongside each job's primary artifacts.

## Event Structure

Each event contains the fields below:

| Field            | Description |
|------------------|-------------|
| `eventType`      | `START`, `COMPLETE`, or `FAIL` |
| `eventTime`      | ISO-8601 timestamp emitted by the script |
| `job`            | Namespace + job name (e.g., `onecare.analytics` / `analytics.metrics_rollup`) |
| `run`            | Run identifier (`runId`) reused across observability metrics and ledgers |
| `dataset`        | Dataset metadata: logical name, semantic version, schema identifier/format |
| `inputs`/`outputs` | Array of datasets with `uri` references and optional facets (partitions, mode) |
| `git`            | Commit hash that produced the run |
| `status`         | `RUNNING`, `COMPLETED`, `FAILED`, or `SKIPPED` depending on phase |
| `attributes`     | Start-time metadata (windows, partitions, thresholds, etc.) |
| `result`         | Run outcomes (rows processed, files archived, durations) |
| `error`          | Message emitted when `eventType === "FAIL"` |

Events are appended via `scripts/analytics/lineage.js`. Override the default log location with
`ANALYTICS_LINEAGE_LOG` when running in CI or containers.

## Job Coverage

| Script | Lineage Log (default) | Dataset | Schema ID |
|--------|-----------------------|---------|-----------|
| `scripts/metrics_rollup.js` | `<rollup-dir>/lineage/metrics_rollup.jsonl` | Aggregated rollups | `analytics_rollup_v1` |
| `scripts/analytics_backfill.js` | `<ledger-dir>/lineage/analytics_backfill.jsonl` | Aggregated rollups | `analytics_rollup_v1` |
| `scripts/analytics_quality.js` | `<report-dir>/lineage/analytics_quality.jsonl` | Quality markdown report | `analytics_quality_report_v1` |
| `scripts/analytics_quarantine_export.js` | `<archive-root>/lineage/analytics_quarantine_export.jsonl` | Quarantine archive | `analytics_quarantine_archive_v1` |

All jobs capture the git commit for traceability and surface the same dataset version that is written to ledgers or
exported artifacts. When a job fails, a `FAIL` event is emitted before the process exits non-zero so downstream
collectors can alert.

## Example Event

```json
{
  "eventType": "COMPLETE",
  "eventTime": "2025-10-18T23:00:00.000Z",
  "job": { "namespace": "onecare.analytics", "name": "analytics.metrics_rollup" },
  "run": { "runId": "c3d9f2dd-8f65-4e26-8a3f-1accc3e3b9f0" },
  "producer": "onecare.analytics.scripts",
  "dataset": {
    "name": "analytics.rollups",
    "version": "v1",
    "schema": { "id": "analytics_rollup_v1", "format": "jsonl" }
  },
  "inputs": [{ "namespace": "onecare.analytics", "name": "analytics.metrics.jsonl", "uri": "/var/analytics/metrics.jsonl" }],
  "outputs": [{ "namespace": "onecare.analytics", "name": "analytics.rollups.jsonl", "uri": "/var/analytics/rollup.jsonl" }],
  "git": { "commit": "2e7a6ce1f4d1c5b9f2de7f40fd52b6b86309a6aa" },
  "status": "COMPLETED",
  "result": {
    "mode": "incremental",
    "windows": ["1m", "5m", "1d"],
    "metricsProcessed": 3284,
    "rollupsWritten": 452,
    "durationMs": 713
  }
}
```

## Inspecting Events Locally

```bash
jq 'select(.eventType=="FAIL")' var/analytics/lineage/metrics_rollup.jsonl
```

To correlate with ledgers, filter by `run.runId` and compare against job entries in `var/analytics/backfill-ledger.jsonl`.
When shipping to a central lineage store, stream the JSONL file as-is; the schema is OpenLineage-compatible so
consumers such as Marquez can ingest it without transformation.

