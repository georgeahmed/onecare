# Feature Monitoring & SLIs

This guide outlines the signals, alerts, and tooling used to monitor feature-store health across ingestion, freshness,
and serving layers.

## Key Metrics

| Metric | Source | Description | Target |
|--------|--------|-------------|--------|
| `feature_ingest_ok_total` | Ingestion worker | Successful writes per feature set | Growing steadily; spikes investigated |
| `feature_ingest_error_total` | Ingestion worker | Failed writes (after retries) | Zero; alert on first occurrence |
| `feature_ingest_lag_ms` | Ingestion worker | Time between event timestamp and persistence | p95 < 5 000 ms |
| `feature_dq_violations_total` | DQ checker (pushgateway) | Range/domain/monotonic failures | Zero; alert on sustained >0 |
| `feature_freshness_age_ms` | DQ checker | Age of features vs. configured SLO | p95 < config `maxAgeSeconds` |
| `feature_serving_latency_ms` | Online store | End-to-end read latency (p95) | < 50 ms |

## Dashboards

1. **Ingestion Throughput** — Display writes/sec per feature set, error counters, and DLQ counts.
2. **Freshness & DQ** — P50/P95 age of features, violation counts by reason (range/domain/monotonic), and quarantine size.
3. **Serving Health** — Read latency percentiles, cache hit rate, and success/error ratios.

Link dashboards to the runbooks in `docs/FEATURE_DQ.md` (data quality) and `docs/FEATURE_LIFECYCLE.md` (retention).

## Alerts

- **Ingestion Failure** — fire when `feature_ingest_error_total` increases within a 5-minute window.
- **Freshness Breach** — fire when `feature_dq_freshness_breach_total` > 0 for more than 10 minutes.
- **DQ Violation** — fire when any constraint counter > 0 twice in succession.
- **Serving Latency** — fire when `feature_serving_latency_ms` p95 exceeds 100 ms for 5 minutes.

## Automation Hooks

- Run `node scripts/feature_store/dq.js` hourly and push summary metrics to Prometheus or a Pushgateway.
- Export PSI/skew metrics via `scripts/feature_store/skew.js` on the weekly cadence and publish PSI values to
  `feature_skew_psi{featureSet,field}`.
- Ship quarantine files produced by the DQ script to the cold tier alongside analytics quarantines.
- Combine the monitoring outputs with the analytics playback harness to validate end-to-end behaviour in CI.
- Provide MLOps with scrape endpoints (Prometheus job `feature-store-monitoring`) and example alert rules (see
  `infra/monitoring/feature_alerts.yml`).

## Operational Checklist

- [ ] DQ checker runs on schedule and uploads quarantine artefacts.
- [ ] Alerts configured for ingestion failures, freshness SLO breaches, and serving latency.
- [ ] Dashboards reviewed weekly with the Feature Ops rotation.
- [ ] IAM changes reviewed against `docs/FEATURE_GOVERNANCE.md`.
- [ ] MLOps notified of skew breaches and SLO misses (handoff documented in `docs/FEATURE_SLO.md`).
