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
