# Feature Store SLOs & Handoff Checklist

This document captures the service-level objectives agreed between Data Engineering and MLOps for the
feature platform. Use it during readiness reviews and incident response.

## Availability & Freshness

| SLO | Target | Measurement | Notes |
|-----|--------|-------------|-------|
| Online read latency (p95) | ≤ 50 ms | `feature_serving_latency_ms` | Measured over 5-minute windows. |
| Ingestion success rate | ≥ 99.5 % | `feature_ingest_ok_total / (ok + error)` | Retries excluded; DLQ breaches trigger incident. |
| Feature freshness | 95 % of records < `maxAgeSeconds` | `feature_dq_freshness_breach_total` | Freshness windows defined in `config/feature-store/dq.json`. |
| Skew PSI | < 0.1 | `feature_skew_psi{featureSet,field}` | Weekly check comparing training vs serving distributions. |

## Alert Routing

| Alert | Threshold | Primary Owner | Backup |
|-------|-----------|---------------|--------|
| Ingestion failure | `feature_ingest_error_total` increase | Data Engineering (telemetry) | MLOps |
| Freshness breach | `feature_dq_freshness_breach_total > 0` for 10 min | Data Engineering | MLOps |
| Serving latency | `feature_serving_latency_ms` p95 > 100 ms for 5 min | MLOps | Data Engineering |
| Skew PSI breach | PSI ≥ 0.1 for 2 runs | MLOps | Data Engineering |

## Dashboard Expectations

- **Ingestion** — Throughput, error counters, DLQ size (`feature_ingest_*`).
- **Freshness & DQ** — Age percentiles, violation counts, quarantine backlog (`feature_dq_*`).
- **Serving** — Latency percentiles, cache hit rate, error distribution.
- **Skew** — PSI time-series per key feature, annotated with deployments.

## Handoff Checklist

- [ ] Monitoring pipelines export metrics listed above.
- [ ] Alerts deployed in `infra/monitoring/feature_alerts.yml` with rotations configured.
- [ ] Runbooks: `docs/FEATURE_DQ.md`, `docs/FEATURE_MONITORING.md`, `docs/FEATURE_SKEW.md`, and `docs/FEATURE_GOVERNANCE.md` linked from team status pages.
- [ ] Playback + DQ jobs wired into CI (see `.github/workflows/analytics-playback.yml`).
- [ ] MLOps confirms dashboard coverage and on-call rota updates.

Keep this document up to date as new feature sets or monitoring requirements are added.
