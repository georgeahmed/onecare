# Offline Feature Store

## Layout
- Root prefix: `s3://<bucket>/feature-store/`
- Partitioning: `featureSet=/.../event_date=YYYY-MM-DD/entity_bucket=XX`
- File format: Delta Lake (Parquet)
- Utilities: `@onecare/feature-store-offline` provides `planPartition` to determine file destinations.

## Point-in-Time Tables
- Construct PIT rows with `buildPointInTimeTable(snapshots)`; returns `effective_from`/`effective_to` windows per entity.
- Query helper `selectPointInTime(rows, { entityId, featureSet, asOf })` ensures no leakage across label timestamps.

## Write Workflow
1. Ingestion job receives validated payloads via `FeatureIngestionWorker`.
2. Convert envelope to `FeatureSnapshot` (see package types).
3. Call `planPartition` to determine Delta partition path and append record.
4. Use `scripts/feature_backfill.js` for historical replays (see `docs/FEATURE_BACKFILL.md`).
5. Periodically run compaction + optimize jobs and refresh materialised views (`docs/FEATURE_VIEWS.md`).

## Schema Evolution
- Additive only; bump schema `$id` for breaking changes and record update in `docs/ADR/2025-10-12-feature-offline-store.md`.
- Regenerate contracts: `npm run --workspaces=false codegen`.
- Ensure registry entry (`schemas/features/registry.json`) updated to reflect new partitioning or TTL semantics.

## Validation & Tests
- Unit coverage in `packages/feature-store-offline/test`.
- Integration smoke: `npm run feature:backfill` (JSONL) + offline planner to Delta (future work).
