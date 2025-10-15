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
Progress: 28%

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

Incomplete
- [ ] DE-02.6 — Feature registry: entities, join keys, schema versioning (codegen + validators) (Outstanding: no registry docs or generated validators committed.)
- [ ] DE-02.7 — Offline store layout (Parquet/Delta): partitioning, PIT tables, schema evolution (Outstanding: no offline store layout or storage notes implemented.)
- [ ] DE-02.8 — Online store adapter (memory/Redis) with TTL, upsert semantics, health/readiness (Outstanding: only in-memory dev store present; no Redis/online adapter.)
- [ ] DE-02.9 — Point‑in‑time join library (leakage‑safe training sets) + tests (Outstanding: no PIT join utilities or tests found.)
- [ ] DE-02.10 — Streaming ingestion (events→features) with idempotency, retries+jitter, DLQ (Outstanding: no streaming ingestion adapter/pipeline implemented.)
- [ ] DE-02.11 — Feature views & transformations (sliding windows, aggregates) + materialization (Outstanding: no feature view pipelines or materialization jobs.)
- [ ] DE-02.12 — Data quality & freshness (constraints, SLI, alerts) and quarantine (Outstanding: no DQ checks or freshness monitors wired for features.)
- [ ] DE-02.13 — Privacy & governance (PII minimization, IAM, encryption, audit logs) (Outstanding: no governance/PII docs or automation delivered.)
- [ ] DE-02.14 — Backfill/recompute framework (range runs, job metadata, idempotent writes) (Outstanding: only single-run backfill script exists; no framework.)
- [ ] DE-02.15 — Training/serving skew detection harness (monitoring hooks) (Outstanding: no skew detection harness or metrics.)
- [ ] DE-02.16 — Drift monitoring integration (handoff to MLOps) + docs (Outstanding: no drift integration or docs.)
- [ ] DE-02.17 — Performance/load testing (throughput/latency; cache strategy; cost/perf) (Outstanding: no load testing artifacts.)
- [ ] DE-02.18 — Documentation & ADRs (registry, offline/online stores, PIT, DQ, governance) (Outstanding: docs referenced in task not yet created.)
