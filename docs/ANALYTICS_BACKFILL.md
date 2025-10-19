# Analytics Backfill & Reprocessing

The analytics backfill CLI re-processes historical metric partitions, writes the results using the idempotent
rollup writer, and records durable job metadata for governance and resumability. Use this workflow whenever
you need to regenerate rollups after an incident, hydrate new storage tiers, or validate incoming historical
drops from partners.

## CLI Usage

```
npm run analytics:backfill -- \
  --start 2025-01-01 \
  --end 2025-01-07 \
  --input-root data/analytics/raw \
  --output var/analytics/rollup.jsonl \
  --ledger var/analytics/backfill-ledger.jsonl \
  --parallelism 4
```

Supported flags:

| Flag | Description | Default |
|------|-------------|---------|
| `--start`, `--end` | Inclusive date range (`YYYY-MM-DD`). Use `--date` for a single partition. | Required |
| `--input-root` | Root directory containing per-day metric drops (`<root>/<YYYY-MM-DD>/*.jsonl`). | `var/analytics/backfill` |
| `--output` | Rollup sink consumed by the analytics lake writer. | `var/analytics/rollup.jsonl` |
| `--ledger` | Durable JSONL ledger tracking job and partition events. | `var/analytics/backfill-ledger.jsonl` |
| `--windows` | Override rollup windows (comma separated, e.g. `1m,5m,1d`). | Inherits defaults from `metrics_rollup` |
| `--parallelism` | Maximum concurrent partitions processed. Writes remain serialized to protect idempotent upserts. | `2` |
| `--dry-run` | Simulate the run without writing rollups. Ledger entries are tagged `dry-run`. | disabled |
| `--resume` | Resume an earlier run by skipping partitions already marked `success` in the ledger. | disabled |

The CLI reuses `metrics_rollup.js` for aggregation, guaranteeing the same sliding-window logic and idempotent
upserts. Writes are serialized through an internal queue so parallel partition processing never races on the
shared JSONL sink.

## Ledger Structure

Entries are appended as JSON objects (one per line) under `var/analytics/backfill-ledger.jsonl`. Two event types
are emitted:

- **Job events** &mdash; `{"type":"job","event":"start|complete","runId":"...","jobKey":"...","params":{...}}`
- **Partition events** &mdash; `{"type":"partition","event":"start|complete|resume-skip|error","partition":{"date":"YYYY-MM-DD"},"status":"success|dry-run|skipped|failed",...}`

Each job entry also captures the emitting Git commit (`gitCommit`) and the dataset schema identifier
(`datasetSchemaId`). The `jobKey` hashes the date range, input root, output path, and rollup windows. When
`--resume` is supplied the CLI skips partitions already recorded as `status: "success"` for the same key,
allowing safe restarts without reprocessing. Failed or skipped partitions remain in the queue until they succeed.

Sample ledger snippet:

```json
{"type":"job","event":"start","runId":"2f5e...","jobKey":"0f98...","gitCommit":"<sha>","datasetSchemaId":"analytics_rollup_v1","params":{"startDate":"2025-01-01","endDate":"2025-01-02","parallelism":2,"dryRun":false}}
{"type":"partition","event":"start","partition":{"date":"2025-01-01"},"runId":"2f5e...","jobKey":"0f98..."}
{"type":"partition","event":"complete","partition":{"date":"2025-01-01"},"status":"success","metricsProcessed":742,"rollupsWritten":48,"runId":"2f5e...","jobKey":"0f98..."}
{"type":"partition","event":"resume-skip","partition":{"date":"2025-01-02"},"status":"skipped","reason":"already_completed","runId":"b4c7...","jobKey":"0f98..."}
{"type":"job","event":"complete","status":"completed","processedPartitions":2,"skippedPartitions":0,"failedPartitions":0,"runId":"2f5e...","jobKey":"0f98...","gitCommit":"<sha>","datasetSchemaId":"analytics_rollup_v1"}
```

Rotate the ledger periodically (e.g. via object storage lifecycle rules) after exporting to governance systems.
Do **not** delete it before confirming the run has been ingested by lineage/audit sinks.

## Operational Safeguards

- The CLI logs structured events via `@onecare/observability` (`analytics.backfill.*`) for dashboards and alerts.
- Partition failures keep the overall run in `failed` state and exit with a non-zero status. Provide the missing
  data and re-run with `--resume` to process only the remaining partitions.
- Dry-run mode validates inputs and ledger wiring without mutating sinks; use it for change reviews and new
  pipelines.
- When backfilling large ranges, start with a low parallelism value and gradually increase while watching storage
  I/O, since rollup writes remain serialized.

## Validation Checklist

- Validate the rollup output (`var/analytics/rollup.jsonl`) using spot checks or the storage layout tests.
- Confirm ledger entries captured each partition with accurate `metricsProcessed`/`rollupsWritten` counts.
- Emit lineage events (see `docs/ANALYTICS_LINEAGE.md`) and ensure the backfill run appears in the governance
  catalog alongside the correlated ledger run id.
