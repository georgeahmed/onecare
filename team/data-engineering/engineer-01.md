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
Progress: 60%

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
- [x] DE-01.9 — Storage design (Parquet layout, partitioning, schema evolution, compaction) (`docs/adr/2025-10-18-analytics-storage.md`, `scripts/analytics_storage_layout.js`, and `test/scripts/analytics_storage_layout.test.ts` now provide Parquet partitions, compaction, and roundtrip coverage.)
- [x] DE-01.12 — Incremental rollups (windowed p50/p95, idempotent upserts, backfill) (Delivered in `scripts/metrics_rollup.js` with sliding-window aggregation, idempotent `writeRollups`, and backfill support plus coverage in `test/scripts/metrics_rollup.test.ts`.)
- [x] DE-01.15 — Pipeline observability (ingest lag, sink latency, error rates; dashboards) (Offline jobs now emit observability metrics via `@onecare/observability` in `scripts/metrics_rollup.js`, `scripts/analytics_quality.js`, and `scripts/analytics_quarantine_export.js`; dashboards updated in `docs/ANALYTICS_DASHBOARDS.md`.)

Incomplete
- [ ] DE-01.13 — Backfill & reprocessing framework (range runs, job metadata, idempotency) (Outstanding: no `scripts/analytics_backfill.js`, ledger, or `docs/ANALYTICS_BACKFILL.md`; rollup tooling lacks resumable metadata.)
- [ ] DE-01.14 — Lineage & metadata (OpenLineage hooks; dataset/version tags) (Outstanding: analytics scripts log progress but emit no lineage payloads; `docs/ANALYTICS_LINEAGE.md` missing.)
- [ ] DE-01.16 — Retention & lifecycle (TTL, cold storage tiering, vacuum) (Outstanding: no retention ADR or `scripts/analytics_retention.js`; only quarantine exporter manages archival flows.)
- [ ] DE-01.17 — Security & governance (encryption, IAM least-privilege, secrets, access logs) (Outstanding: `docs/ANALYTICS_SECURITY.md` and IAM policy samples not authored.)
- [ ] DE-01.18 — Performance/load testing (throughput, backpressure, cost/perf notes) (Outstanding: no analytics-specific load generator or `docs/ANALYTICS_PERF.md` present.)
- [ ] DE-01.19 — Documentation & ADRs (storage choice, partitioning, DQ policy, reprocessing) (Outstanding: storage ADR/backfill runbook and expanded DQ tables not yet written.)
- [ ] DE-01.20 — Sandbox playback harness (deterministic event generator for CI) (Outstanding: no playback harness CLI, fixtures, or CI workflow committed.)
