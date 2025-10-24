# Feature Backfill & Recompute

This guide documents how to replay historical events and recompute feature payloads using
`scripts/feature_backfill.js`. The framework mirrors the analytics backfill tooling (DE-01.13) with
ledger tracking, resumable partitions, and dry-run safety.

## CLI Usage

```
# Single file replay (triage-core)
node scripts/feature_backfill.js \
  --input data/backfill/triage-core.jsonl \
  --feature-set triage-core \
  --output var/features/triage-core.jsonl

# Date-ranged replay pulling files from data/backfill/<YYYY-MM-DD>/
node scripts/feature_backfill.js \
  --input-root data/backfill \
  --start 2025-01-01 \
  --end 2025-01-07 \
  --feature-set triage-core \
  --output var/features/triage-core.jsonl \
  --parallelism 4
```

Key flags:

| Flag | Description | Default |
|------|-------------|---------|
| `--input` / `-i` | Single JSONL file containing source events | `data/backfill/triage-input.jsonl` |
| `--input-root` | Directory containing per-day folders (`<root>/<YYYY-MM-DD>/<feature-set>.jsonl`) | `data/backfill` |
| `--start`, `--end`, `--date` | Inclusive date range (required with `--input-root`) | n/a |
| `--feature-set` | Feature set to derive (`triage-core`, `acuity-signal`) | `triage-core` |
| `--output` | Target JSONL snapshot | `var/features/triage-core.jsonl` |
| `--ledger` | Ledger file capturing job metadata | `var/features/backfill-ledger.jsonl` |
| `--parallelism` | Concurrent partitions processed | `2` |
| `--dry-run` | Parse + validate without writing | disabled |
| `--resume` | Skip partitions previously marked success/dry-run in ledger | disabled |

## Ledger & Resume

`var/features/backfill-ledger.jsonl` stores job and partition entries with run IDs, partition dates,
record counts, and durations. A job key hashes the feature set, output path, and partition list.
Running with `--resume` skips partitions whose ledger entries already report `status = success` (or
`dry-run`). Ledger entries are append-only; rotate the file periodically after exporting to governance
systems.

Sample entry:

```json
{"type":"partition","event":"complete","jobKey":"6d8c…","runId":"887c…","partition":{"date":"2025-01-02"},"status":"success","processed":420,"written":410,"invalid":10,"durationMs":812}
```

## Idempotent Writes

The script merges derived payloads with existing JSONL snapshots by key
`<featureSet>|<entityId>|<asOf>`. Re-running the backfill (even with overlapping partitions) updates
records in place. The optional in-memory feature store hydrator mirrors the online write path and can
be swapped for the production client once available.

## Supported Feature Sets

- `triage-core` — Derived from triage input envelopes; clamps scores to `[0,1]`, populates
  `generatedAt`, `compositeScore`, and carries extensions.
- `acuity-signal` — Pass-through for model outputs with score/confidence clamped to `[0,1]`.

Extend `deriveFeatureRecords` when onboarding additional feature sets; ensure schema validation via
`@onecare/ports` or the generated registry.

## Operational Safeguards

- **Dry-run first** — Use `--dry-run` to validate inputs and ledger wiring without mutating sinks.
- **Parallelism** — Tune `--parallelism` based on source file size. Writes remain serialised to keep
  JSONL snapshots consistent.
- **Monitoring** — Inspect the JSON output from the script (per-run summary) and ledger entries. Pair
  with the DQ checker (`scripts/feature_store/dq.js`) to validate outputs before promoting.
- **Rollback** — Because writes are idempotent JSONL merges, rolling back involves restoring the
  previous snapshot (e.g., from object store versioning) and re-running the backfill.

## Validation Checklist

1. Dry-run against the target range (`--dry-run --resume`).
2. Execute the write run without `--dry-run`.
3. Review ledger entries (`jq '.' var/features/backfill-ledger.jsonl | tail`).
4. Run `node scripts/feature_store/dq.js --input <output.jsonl>` to ensure no constraint violations.
5. Archive the ledger snapshot alongside the generated dataset for audit.

