# Analytics Retention and Lifecycle Policy

- Status: Accepted
- Date: 2025-10-19
- Owners: Data Engineering (Telemetry/ETL)

## Context

Telemetry rollups, backfill artefacts, and lineage logs had no lifecycle guarantees. Raw metric drops accumulated
indefinitely under `var/analytics/backfill`, Parquet partitions under `var/analytics/lake` never expired, and
supporting metadata (lineage, backfill ledgers) grew without compaction. This violated our storage minimisation
commitments and made it difficult to keep cold storage costs predictable.

## Decision

1. **Dataset TTLs** — enforce the following retention windows (aligned with regulatory and analytical needs):
   | Dataset | Path | TTL | Action |
   |---------|------|-----|--------|
   | Raw metric drops | `var/analytics/backfill` | 30 days | Move to cold storage (or delete if `--delete`) |
   | Aggregated rollups (Parquet) | `var/analytics/lake` | 365 days | Move to cold storage/hardened bucket |
   | Lineage & job metadata | `var/analytics/lineage` + job-specific lineage logs | 180 days | Move to cold storage |
   | Backfill ledger | `var/analytics/backfill-ledger.jsonl` | 365 days | Compact in place (drop older entries) |

2. **Automation** — `scripts/analytics_retention.js` executes the policy:
   - CLI options expose TTL overrides, a `--dry-run` preview, cold tiering via `--tier-dir` (defaults to
     `var/analytics/cold`), and `--vacuum` to prune empty partition directories after compaction.
   - Each action logs structured metadata (`dataset`, `action`, `path`) and emits observability metrics under
     `analytics.retention.*` for dashboards/alerts.
   - Rollup and raw partitions default to tiering; passing `--delete` forces immediate deletion.
   - Ledger compaction rewrites the JSONL file, keeping only entries newer than the cutoff while preserving schema.

3. **Cold Storage Layout** — tiered artefacts retain their relative paths beneath `var/analytics/cold/` so that
   offline recovery only requires retargeting the root prefix (e.g., rehydrate `lake/date=...` to replay). Cold
   storage can be pointed to an object bucket by reconfiguring `ANALYTICS_TIER_ROOT` in production.

4. **Scheduling** — run the retention job nightly (see `infra/automation/analytics-retention.cron` for the dev/staging/prod
   entries that target the `s3://onecare-analytics-cold-<env>` buckets) so cold storage stays in sync. Dry-run mode
   (`--dry-run`) is available for change management and staging checks.

## Consequences

- Storage footprint for raw and rollup artefacts is bounded; operators can rely on 12 months of rollups and 30 days
  of raw metrics before data moves to cold storage.
- Lineage catalogues stay concise, reducing ingestion load on governance systems.
- Backfill ledgers remain readable because older entries are compacted instead of moving the file.
- The retention script becomes part of the analytics maintenance playbook; future datasets must be added to the
  policy table and the CLI.

## Implementation Notes

- The script respects environment overrides (`ANALYTICS_LAKE_PATH`, `ANALYTICS_BACKFILL_ROOT`,
  `ANALYTICS_LINEAGE_DIR`, `ANALYTICS_BACKFILL_LEDGER`, `ANALYTICS_TIER_ROOT`) to align with production mounts.
- `--now <ISO>` allows deterministic testing; production runs rely on wall-clock time.
- Vacuuming removes empty directories left by compaction to keep partition listings cheap (especially for object
  stores that charge per key).
- When exporting cold artefacts to cloud storage, configure lifecycle policies there to apply eventual deletion per
  compliance requirements.
