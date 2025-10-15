Engineer: Data Engineering 01

Role: Data Engineer (Telemetry/ETL)
Stack: Python/TS, ETL, Warehousing

Responsibilities
- Telemetry pipelines; analytics metrics; data hygiene.

Initial Tasks
- Ingest metrics events; build analytics sink; basic dashboards.

Start Here
- Algorithm.md: 12) Observability, analytics.* topics
- Schemas: schemas/analytics/metric.json

Status: in-progress
Progress: 50%

Dependencies
- devops-sre/engineer-02 (Observability stack)
- backend/engineer-06 (Capacity Shaper telemetry)

Platform Checklist (pre-flight)
- Metrics sink reachable (DB/file/object store); credentials via secrets; retention policies defined.
- Schemas for analytics.metric compiled; validators in pipeline; PHI-free payloads.
- Bus connectivity for analytics.* topics (if consuming); DLQ subjects available.
- Observability pipeline validated end-to-end; no PII in logs/dashboards.

Tasks

Completed
- [x] DE-01.1 — Configure analytics sink (file/DB) + env wiring
- [x] DE-01.2 — Implement consumer for analytics.metric envelopes -> sink
- [x] DE-01.3 — Daily rollup ETL (counts, p95 latencies) job script
- [x] DE-01.4 — Basic dashboards (arrival rate, error rate, latency)
- [x] DE-01.5 — Data hygiene checks (missing fields, outliers) + report
- [x] DE-01.6 — Analytics payload schema validation
- [x] DE-01.7 — Contract-first analytics models (schema versioning, codegen, compiled validators)
- [x] DE-01.8 — Reliable consumer (at-least-once, idempotency keys, retries+jitter, DLQ)
- [x] DE-01.10 — Privacy & PHI minimization (labels allowlist, redaction, PII guardrails)
- [x] DE-01.11 — Data quality checks (constraints, domains, quarantine invalids; report)

Incomplete
- [ ] DE-01.9 — Storage design (Parquet layout, partitioning, schema evolution, compaction) (Outstanding: no analytics storage ADR or Parquet layout/compaction tooling in repo.)
- [ ] DE-01.12 — Incremental rollups (windowed p50/p95, idempotent upserts, backfill) (Outstanding: only daily rollup script present; no sliding window upserts or backfill mode.)
- [ ] DE-01.13 — Backfill & reprocessing framework (range runs, job metadata, idempotency) (Outstanding: no backfill CLI/ledger or resumable framework implemented.)
- [ ] DE-01.14 — Lineage & metadata (OpenLineage hooks; dataset/version tags) (Outstanding: no lineage emission hooks or supporting docs discovered.)
- [ ] DE-01.15 — Pipeline observability (ingest lag, sink latency, error rates; dashboards) (Outstanding: ingest metrics exist, but dashboards still lack lag/retry/DLQ panels and no aggregation pipeline publishes them.)
- [ ] DE-01.16 — Retention & lifecycle (TTL, cold storage tiering, vacuum) (Outstanding: retention ADR/job absent; no lifecycle tooling committed.)
- [ ] DE-01.17 — Security & governance (encryption, IAM least-privilege, secrets, access logs) (Outstanding: analytics security/governance documentation missing.)
- [ ] DE-01.18 — Performance/load testing (throughput, backpressure, cost/perf notes) (Outstanding: no load generator or performance study assets.)
- [ ] DE-01.19 — Documentation & ADRs (storage choice, partitioning, DQ policy, reprocessing) (Outstanding: dependent docs/ADRs not authored.)
- [ ] DE-01.20 — Sandbox playback harness (deterministic event generator for CI) (Outstanding: no playback harness or fixtures in repo.)
