# Feature Views

## Purpose
- Provide reusable, versioned transformations on top of base feature sets.
- Support sliding-window aggregates needed for prioritisation models and operational monitors.
- Expose consistent metadata for offline (data lake) and online (feature store) materialisation.

## Current Views

### triage-core.sliding-windows (v1)
- **Source**: `triage-core`
- **Target feature set**: `triage-core-windowed`
- **Windows**: 1h, 6h, 1d, 7d, 30d
- **Signals**:
  - Rolling counts of triage submissions per patient (`counts` map)
  - Rolling averages for numeric fields (`averages.{field}.{window}`)
  - Latest observed scores (`latest` map)
- **Freshness**: recompute at least hourly; retain 30 days historical snapshots offline.
- **Metadata**: each snapshot carries `metadata.viewName`, `metadata.viewVersion`, and the original source feature set.

## Materialisation

### Offline (Delta/Parquet)
1. Build the package so `@onecare/feature-store-offline` artefacts are available:
   ```bash
   npx tsc -p packages/feature-store-offline/tsconfig.json
   ```
2. Run the materialiser (writes JSONL and, with `--online`, pushes to the configured online store):
   ```bash
   npm run feature:views -- \
     --input data/triage-core.jsonl \
     --output var/features/feature-views.jsonl \
     --view triage-core.sliding-windows \
     --as-of 2025-01-09T12:00:00Z \
     --online
   ```
   - Set `FEATURE_VIEW_ONLINE_TTL_SECONDS` to override the default 3600s TTL.
   - Use `--online-module path/to/custom-module` if you supply a bespoke online store implementation.
3. Optionally emit partition plans by setting `FEATURE_VIEW_PARTITION_ROOT=/lake/features` (logs `planPartition` outputs).

### Online (future work)
- Feed the JSONL output into `@onecare/feature-store-online` using `batchUpsert`.
- TTL defaults to the view freshness (1 hour). When wiring this into pipelines integrate with `FeatureIngestionWorker` for backfills.

## Adding New Views
1. Define a `FeatureViewDefinition` in `packages/feature-store-offline/src/views.ts` (or a dedicated module) and register it via `registerFeatureView`.
2. Provide unit tests under `packages/feature-store-offline/test/*` covering aggregation behaviour.
3. Document the view (source set, windows, freshness) in this file and link it from `docs/FEATURE_README.md` (future consolidation).
4. Update operational tooling (`scripts/feature_store/views.js`) if additional runtime options are required.

## Telemetry
- Materialiser emits metrics:
  - `feature.views.run` counter per view name
  - `feature.views.duration_ms` histogram for job runtime
- Sliding-window view compute emits metrics indirectly via the base CLI; add more if additional dashboards are needed.

## Operational Notes
- Run the materialiser after ingesting base `triage-core` snapshots to keep windowed aggregates fresh.
- Backfill by pointing `--as-of` at the desired horizon and running per day/week partitions.
- The CLI is idempotent for a given `(featureSet, entityId, generatedAt)` tuple, so re-running is safe.
