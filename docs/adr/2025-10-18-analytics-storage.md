# Analytics Storage Layout and Compaction

- Status: Accepted
- Date: 2025-10-18
- Owners: Data Engineering (Telemetry/ETL)

## Context

Analytics rollups were historically persisted as newline-delimited JSON under `var/analytics/rollup.jsonl`.
That approach made downstream querying expensive (full-file scans), provided no partition pruning,
and offered no guardrails for schema evolution or file size management. We also lacked a shared
contract for transforming the JSONL rollups into an analytics lake, which blocked retention, compaction,
and replay work (DE-01.13/DE-01.16/DE-01.19).

We evaluated three options:

1. **Continue with JSONL** – lowest effort but offers no efficient queries and complicates schema evolution.
2. **Adopt Delta Lake** – strong ACID semantics but requires a Spark runtime we do not operate today.
3. **Adopt columnar Parquet with deterministic partitioning** – integrates with existing tooling, supports
   predicate pushdown in warehouses, and keeps the runtime lightweight (Node scripts + object store).

Option (3) gives us scalable analytics while keeping operational complexity low and respecting the
small-footprint constraint for cron/CI jobs.

## Decision

1. **File Format** – persist rollups as Parquet files using the schema below. Numeric rollup statistics remain
   double precision (`FLOAT64`) and label maps are stored as JSON strings for portability.
2. **Partition Layout** – rollups are written beneath a configurable root (default `var/analytics/lake`):
   ```
   <root>/
     date=YYYY-MM-DD/
       metric=<metric-name>/
         window=<window-size>/
           label=<label-hash>/
             analytics-rollup-<run-id>.parquet
   ```
   The `date` derives from the start of the rollup window. The `label` directory keeps label hash collisions
   isolated and allows us to prune efficiently by metric/window/date.
3. **Schema Evolution** – the Parquet schema is versioned implicitly via an additive-only policy:
   - New columns may be appended with defaults.
   - Breaking changes require bumping the output root (e.g., `lake/v2/`) and dual-writing during transition.
   - The writer records the `generatedAt`/`schemaVersion` for auditing.
4. **Compaction** – background compaction merges files smaller than the `TARGET_FILE_BYTES` (defaults to
   192 MiB with an upper bound of 256 MiB). Compaction produces one Parquet file per `(date, metric, window, label)`
   and records a manifest entry (`compaction-manifest.jsonl`) containing run metadata (run id, inputs, outputs,
   counts, duration).
5. **Tooling** – `scripts/analytics_storage_layout.js` implements:
   - Partition planning + Parquet writer (`planPartitions`, `writePartitions`).
   - A reader helper with partition pruning (`readPartitions`).
   - Compaction with manifest emission (`compactPartitions`).
   - CLI surface: `node scripts/analytics_storage_layout.js write|compact|inspect [flags]`.

## Consequences

- Analysts can run predicate-pruned queries by date/metric/window without scanning entire JSONL files.
- Schema migrations must follow the additive policy or stage data into a new namespace.
- Cron jobs now produce Parquet files; downstream consumers must read from the lake root instead of the
  legacy JSONL file.
- The compaction manifest enables DE-01.13 (backfill ledger reuse) and DE-01.16 (retention sweeps) by tracking
  file lineage and sizes.
- Additional operational safeguards (retention, lineage) build on top of this ADR and are covered in subsequent tasks.

## Implementation Notes

- Parquet schema:
  | Column          | Type      | Nullable | Notes                                      |
  |-----------------|-----------|----------|--------------------------------------------|
  | windowSize      | UTF8      | false    | e.g., `1m`, `5m`, `1h`, `1d`               |
  | windowStart     | UTF8      | false    | ISO-8601 string                            |
  | windowEnd       | UTF8      | false    | ISO-8601 string                            |
  | metric          | UTF8      | false    | Metric name                                |
  | labelHash       | UTF8      | false    | Deterministic hash of normalised labels    |
  | labelsJson      | UTF8      | true     | Canonicalised label map JSON               |
  | count           | INT64     | false    | Total samples                              |
  | numericCount    | INT64     | false    | Samples with numeric values                |
  | p50             | DOUBLE    | true     | Percentile values                          |
  | p95             | DOUBLE    | true     | Percentile values                          |
  | generatedAt     | UTF8      | false    | Emission timestamp                         |
  | schemaVersion   | UTF8      | false    | Writer schema version (`analytics_rollup_v1`) |
  | writeRunId      | UTF8      | false    | Writer run identifier                      |

- CLI defaults:
  - `--input` defaults to `var/analytics/rollup.jsonl`.
  - `--output-root` defaults to `var/analytics/lake`.
  - `--target-bytes` defaults to `201326592` (192 MiB).
- Compaction writes manifest entries alongside the affected partition root and guarantees atomic replacement
  (writes to a temp file and renames).

Future ADRs will revisit Delta Lake adoption if we outgrow the single-writer cron model or require ACID merges.
