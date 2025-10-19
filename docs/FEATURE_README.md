# Feature Platform Documentation Hub

Use this index to navigate the feature-store documentation set delivered across DE-02.[12-18].

## Getting Started

1. **Registry & Schemas** — Understand available entities and feature sets.
   - [`docs/FEATURE_REGISTRY.md`](FEATURE_REGISTRY.md)
   - [`docs/FEATURE_SCHEMAS.md`](FEATURE_SCHEMAS.md)
2. **Ingestion & Backfill** — Load historical data and hydrate online/offline stores.
   - [`docs/FEATURE_INGESTION.md`](FEATURE_INGESTION.md)
   - [`docs/FEATURE_BACKFILL.md`](FEATURE_BACKFILL.md) *(backfill ledger & CLI)*
   - [`scripts/feature_backfill.js`](../scripts/feature_backfill.js)
3. **Views & Offline Materialisation** — Build PIT views for training/analytics.
   - [`docs/FEATURE_VIEWS.md`](FEATURE_VIEWS.md)
   - [`docs/FEATURE_OFFLINE_STORE.md`](FEATURE_OFFLINE_STORE.md)
4. **Data Quality & Governance** — Enforce correctness and privacy.
   - [`docs/FEATURE_DQ.md`](FEATURE_DQ.md)
   - [`docs/FEATURE_GOVERNANCE.md`](FEATURE_GOVERNANCE.md)
   - [`docs/FEATURE_MONITORING.md`](FEATURE_MONITORING.md)
   - [`docs/FEATURE_SLO.md`](FEATURE_SLO.md)
5. **Skew & Drift Monitoring** — Hand-off to MLOps.
   - [`docs/FEATURE_SKEW.md`](FEATURE_SKEW.md)
   - [`docs/MLOPS_MONITORING.md`](MLOPS_MONITORING.md)
6. **Performance & Benchmarks** — Load testing guidance.
   - [`docs/FEATURE_PERF.md`](FEATURE_PERF.md)
   - [`scripts/bench/feature_store_load.js`](../scripts/bench/feature_store_load.js)

## Quickstarts

- **Training** — Run `scripts/feature_store/views.js` with the desired view to produce a training dataset, validate with
  `scripts/feature_store/dq.js`, and upload to the ML workspace.
- **Serving** — Hydrate the online store via ingestion (`npm run feature:ingest`) and verify telemetry using the monitoring
  dashboard.
- **Backfill** — Execute `scripts/feature_backfill.js --dry-run --resume`, review the ledger, then run without `--dry-run` and
  refresh downstream views.

## Operational Runbooks

- [`docs/FEATURE_LIFECYCLE.md`](FEATURE_LIFECYCLE.md) — Retention, cold storage, and archival strategy.
- [`docs/FEATURE_MONITORING.md`](FEATURE_MONITORING.md) — Metrics, alerts, and MLOps handoff.
- [`docs/FEATURE_DQ.md`](FEATURE_DQ.md) — Constraint definitions and remediation.
- [`docs/FEATURE_SKEW.md`](FEATURE_SKEW.md) — PSI/JS divergence procedures.

Keep this index updated whenever new feature-store docs or tooling are added.
