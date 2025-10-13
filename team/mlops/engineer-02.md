Engineer: MLOps 02

Role: MLOps Engineer (Feature Store/Monitoring)
Stack: Python, Data pipelines, Monitoring

Responsibilities
- Feature store plumbing; drift/latency monitoring; alerts.

Initial Tasks
- Define feature schemas; implement telemetry to feature store; dashboards.

Start Here
- Algorithm.md: 6) Capacity Shaper telemetry, 13) MLOps
- Ports: packages/ports/src/feature-store.ts

Status: planned
Progress: 0%

Dependencies
- data-engineering team (pipelines)
- ml team (models)

Tasks
- [ ] MO-02.1 — Feature store backend selection (e.g., Redis/SQLite/Postgres) + ADR
- [ ] MO-02.2 — Implement FeatureStore.put/get in TS (@onecare/ports impl)
- [ ] MO-02.3 — Telemetry hook to log features from triage/safety into store
- [ ] MO-02.4 — Drift metrics (PSI/KL or simple mean/std diff) and alerts
- [ ] MO-02.5 — Retention policy + purge job script
- [ ] MO-02.6 — Unit tests and sample report generation
 - [ ] MO-02.7 — Reliable ingestion (at-least-once, idempotency, retries+jitter, DLQ) for feature updates
 - [ ] MO-02.8 — Freshness SLI/SLO (max age per feature) and alerting rules
 - [ ] MO-02.9 — Dashboards for feature health (freshness, drift, null rate) and runbooks
 - [ ] MO-02.10 — Online store health/readiness + cache strategy (hit ratio, TTL tuning)
 - [ ] MO-02.11 — PIT query helper for training sets (leakage-safe) + examples
 - [ ] MO-02.12 — Training/serving skew monitors (PSI/JS divergence) + alerting thresholds
 - [ ] MO-02.13 — Privacy & governance checks (PII minimization, labels allowlist, access controls)
 - [ ] MO-02.14 — Performance/load tests (online get/put p50/p95; backpressure; cost/perf)
 - [ ] MO-02.15 — SDK/notebook examples for ML users (offline/online access patterns)
 - [ ] MO-02.16 — Lifecycle alignment (retention tiers, compaction) with Data Eng policies
 - [ ] MO-02.17 — Incident playbooks (drift spike, freshness breach, store outage)
 - [ ] MO-02.18 — Canary gates for model promotion based on drift/quality metrics
