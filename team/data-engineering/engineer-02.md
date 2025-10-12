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
Progress: 20%

Dependencies
- mlops/engineer-02 (Feature monitoring)
- ml/engineer-02 (Acuity features)

Platform Checklist (pre-flight)
- Feature Store provisioned (DB/object store); schema registry documented; credentials via secrets.
- Feature schemas authored; validators available; data retention/compaction policies set.
- No PII leakage; PHI minimized per policy; access controls applied.

Tasks
- [x] DE-02.1 — Define feature schemas (JSON) + docs
- [ ] DE-02.2 — Implement FeatureStore.put/get TS impl + tests
- [ ] DE-02.3 — Backfill job script from historical events (if any)
- [ ] DE-02.4 — Retention + compaction job (config-driven)
- [ ] DE-02.5 — Sample queries/reports for ML teams
 - [ ] DE-02.6 — Feature registry: entities, join keys, schema versioning (codegen + validators)
 - [ ] DE-02.7 — Offline store layout (Parquet/Delta): partitioning, PIT tables, schema evolution
 - [ ] DE-02.8 — Online store adapter (memory/Redis) with TTL, upsert semantics, health/readiness
 - [ ] DE-02.9 — Point‑in‑time join library (leakage‑safe training sets) + tests
 - [ ] DE-02.10 — Streaming ingestion (events→features) with idempotency, retries+jitter, DLQ
 - [ ] DE-02.11 — Feature views & transformations (sliding windows, aggregates) + materialization
 - [ ] DE-02.12 — Data quality & freshness (constraints, SLI, alerts) and quarantine
 - [ ] DE-02.13 — Privacy & governance (PII minimization, IAM, encryption, audit logs)
 - [ ] DE-02.14 — Backfill/recompute framework (range runs, job metadata, idempotent writes)
 - [ ] DE-02.15 — Training/serving skew detection harness (monitoring hooks)
 - [ ] DE-02.16 — Drift monitoring integration (handoff to MLOps) + docs
 - [ ] DE-02.17 — Performance/load testing (throughput/latency; cache strategy; cost/perf)
 - [ ] DE-02.18 — Documentation & ADRs (registry, offline/online stores, PIT, DQ, governance)
