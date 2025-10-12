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
- [x] DE-01.1 — Configure analytics sink (file/DB) + env wiring
- [x] DE-01.2 — Implement consumer for analytics.metric envelopes -> sink
- [x] DE-01.3 — Daily rollup ETL (counts, p95 latencies) job script
- [ ] DE-01.4 — Basic dashboards (arrival rate, error rate, latency)
- [ ] DE-01.5 — Data hygiene checks (missing fields, outliers) + report
- [ ] DE-01.6 — Analytics payload schema validation
 - [ ] DE-01.7 — Contract-first analytics models (schema versioning, codegen, compiled validators)
 - [ ] DE-01.8 — Reliable consumer (at-least-once, idempotency keys, retries+jitter, DLQ)
 - [ ] DE-01.9 — Storage design (Parquet layout, partitioning, schema evolution, compaction)
 - [ ] DE-01.10 — Privacy & PHI minimization (labels allowlist, redaction, PII guardrails)
 - [ ] DE-01.11 — Data quality checks (constraints, domains, quarantine invalids; report)
 - [ ] DE-01.12 — Incremental rollups (windowed p50/p95, idempotent upserts, backfill)
 - [ ] DE-01.13 — Backfill & reprocessing framework (range runs, job metadata, idempotency)
 - [ ] DE-01.14 — Lineage & metadata (OpenLineage hooks; dataset/version tags)
 - [ ] DE-01.15 — Pipeline observability (ingest lag, sink latency, error rates; dashboards)
 - [ ] DE-01.16 — Retention & lifecycle (TTL, cold storage tiering, vacuum)
 - [ ] DE-01.17 — Security & governance (encryption, IAM least-privilege, secrets, access logs)
 - [ ] DE-01.18 — Performance/load testing (throughput, backpressure, cost/perf notes)
 - [ ] DE-01.19 — Documentation & ADRs (storage choice, partitioning, DQ policy, reprocessing)
 - [ ] DE-01.20 — Sandbox playback harness (deterministic event generator for CI)
