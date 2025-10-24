# ADR: Feature Store Offline Layout

- Status: Accepted
- Date: 2025-10-12
- Owners: Data Engineering
- Related Tasks: DE-02.6, DE-02.7, DE-02.9

## Context
- Feature backfills and model training require a deterministic layout with efficient point-in-time (PIT) lookups.
- Existing artefacts (`scripts/feature_backfill.js`, `scripts/feature_compact.js`) output JSONL without partitioning or PIT semantics.
- Downstream ML pipelines require schema evolution guarantees, de-duplication, and hydration rules that prevent label leakage.

## Decision
1. **Storage Format**: Delta Lake on object storage (S3/Azure) with Parquet files per partition. Aligns with analytics ecosystem and supports ACID merges.
2. **Partition Strategy**: `featureSet/event_date/entity_bucket`
   - `event_date` = `generatedAt` truncated to date (UTC)
   - `entity_bucket` = first two hex characters of `sha1(entityId)` (256-way fan-out)
   - Facilitates partition pruning and balanced file sizes for skewed entities.
3. **Point-in-Time Tables**: Maintain PIT tables (`feature_pit.<featureSet>`) with `effective_from`/`effective_to` windows per entity. Implemented via utilities in `@onecare/feature-store-offline` (`buildPointInTimeTable`, `selectPointInTime`).
4. **Schema Evolution**: Additive changes only. Breaking changes require new schema `$id` and dual-write during migration. Offline layout enforces `additionalProperties: false`; optional columns must use `extensions` map (per schema guidance).
5. **Compaction**: Retain small files (<128 MB) by batching writes through the offline layout planner. Use `scripts/feature_compact.js` after ingestion or scheduled compaction jobs.
6. **Governance**: Metadata (owners, SLA, TTL) sourced from `schemas/features/registry.json` and propagated to Delta table properties.

## Consequences
- Training pipelines can build leakage-safe datasets using the new PIT utilities; sample code added in `packages/feature-store-offline/test`.
- Ingestion jobs must populate `entity_bucket` and `event_date` when writing to object storage. Helper `planPartition` emits file paths.
- Schema updates require synchronizing registry, running codegen, and coordinating dual-write windows.
- Additional monitoring needed: Delta optimize jobs, partition skew metrics (to be handled by forthcoming DQ tasks).

## References
- `schemas/features/registry.json`
- `docs/FEATURE_REGISTRY.md`
- `packages/feature-store-offline`
- `packages/feature-store-ingest`
