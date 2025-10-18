Engineer: Data Engineering 02

Role: Data Engineer (Feature Store)
Stack: Python/TS, Feature Store

Responsibilities
- Define and maintain ML feature store schemas & pipelines.

Initial Tasks
- Implement FeatureStore interface; batch/backfill jobs.

Start Here
- Algorithm.md: 6) Capacity Shaper, 13) MLOps
- Ports: packages/ports/src/feature-store.ts

Status: in-progress
Progress: 61%

Dependencies
- mlops/engineer-02 (Feature monitoring)
- ml/engineer-02 (Acuity features)

Platform Checklist (pre-flight)
- Feature Store provisioned (DB/object store); schema registry documented; credentials via secrets.
- Feature schemas authored; validators available; data retention/compaction policies set.
- No PII leakage; PHI minimized per policy; access controls applied.

Tasks

Completed
- [x] DE-02.1 — Define feature schemas (JSON) + docs (`schemas/features/*.json`, `docs/FEATURE_SCHEMAS.md`)
- [x] DE-02.2 — Implement FeatureStore.put/get TS impl + tests (`packages/feature-store-memory`)
- [x] DE-02.3 — Backfill job script from historical events (if any) (`scripts/feature_backfill.js`)
- [x] DE-02.4 — Retention + compaction job (config-driven) (`scripts/feature_compact.js`)
- [x] DE-02.5 — Sample queries/reports for ML teams (`docs/FEATURE_QUERIES.md`)
- [x] DE-02.6 — Feature registry: entities, join keys, schema versioning (codegen + validators) (`schemas/features/registry*.json`, `docs/FEATURE_REGISTRY.md`, `packages/ports/src/features.ts`)
- [x] DE-02.7 — Offline store layout (Parquet/Delta): partitioning, PIT tables, schema evolution (`docs/adr/2025-10-12-feature-offline-store.md`, `docs/FEATURE_OFFLINE_STORE.md`, `@onecare/feature-store-offline`)
- [x] DE-02.8 — Online store adapter (memory/Redis) with TTL, upsert semantics, health/readiness (`packages/ports/src/feature-store.ts`, `@onecare/feature-store-online`)
- [x] DE-02.9 — Point‑in‑time join library (leakage‑safe training sets) + tests (`packages/feature-store-offline/src/pit.ts`, associated Vitest coverage)
- [x] DE-02.10 — Streaming ingestion (events→features) with idempotency, retries+jitter, DLQ (`@onecare/feature-store-ingest`, `scripts/feature_store/ingest_stream.js`, `docs/FEATURE_INGESTION.md`)
- [x] DE-02.11 — Feature views & transformations (sliding windows, aggregates) + materialization (`packages/feature-store-offline/src/views.ts`, `packages/feature-store-offline/test/views.test.ts`, `scripts/feature_store/views.js`, `docs/FEATURE_VIEWS.md`)

Incomplete
- [ ] DE-02.12 — Data quality & freshness (constraints, SLI, alerts) and quarantine (Outstanding: no `scripts/feature_store/dq.js`, `docs/FEATURE_DQ.md`, or monitoring hooks; ingestion currently validates schema only.)
- [ ] DE-02.13 — Privacy & governance (PII minimization, IAM, encryption, audit logs) (Outstanding: `docs/FEATURE_GOVERNANCE.md` and IAM samples under `config/feature-store/` not present.)
- [ ] DE-02.14 — Backfill/recompute framework (range runs, job metadata, idempotent writes) (Outstanding: `scripts/feature_backfill.js` still lacks ledger metadata, resume/dry-run flags, and only targets the in-memory sink; no `docs/FEATURE_BACKFILL.md`.)
- [ ] DE-02.15 — Training/serving skew detection harness (monitoring hooks) (Outstanding: no skew CLI (`scripts/feature_store/skew.js`) or docs; monitoring metrics absent.)
- [ ] DE-02.16 — Drift monitoring integration (handoff to MLOps) + docs (Outstanding: `docs/FEATURE_MONITORING.md`/`docs/FEATURE_SLO.md` not authored; no defined metrics export.)
- [ ] DE-02.17 — Performance/load testing (throughput/latency; cache strategy; cost/perf) (Outstanding: `scripts/bench/feature_store_load.js` and `docs/FEATURE_PERF.md` missing.)
- [ ] DE-02.18 — Documentation & ADRs (registry, offline/online stores, PIT, DQ, governance) (Outstanding: consolidated `docs/FEATURE_README.md` and the missing guides (DQ/governance/backfill/monitoring/skew) not yet written.)
