# Feature Freshness SLOs

This guide defines freshness objectives for online features and explains how to monitor breaches.

## Metrics

- `features.freshness.lag_ms` (histogram): recorded by the ingestion worker after each successful upsert (`packages/feature-store-ingest`). Lag is computed as `now - asOf`.
- Dimensions:
  - `featureSet`: name of the feature set (e.g. `triage-core`, `acuity-signal`).

Recommended PromQL examples:

```promql
histogram_quantile(0.95, sum(rate(features_freshness_lag_ms_bucket[5m])) by (le, featureSet))
```

## Targets

Feature Set | 95th Percentile Lag | Breach Action
--- | --- | ---
`triage-core` | ≤ 120s | Investigate ingestion backlog; check DLQ volume.
`acuity-signal` | ≤ 180s | Validate downstream model availability.

Adjust thresholds as new feature sets are onboarded. Document updates in this table and in dashboards.

## Alerting

Alert rules live in `infra/monitoring/feature_alerts.yml`:

- `FeatureFreshnessBreach`: fires when p95 lag exceeds the target for 15 minutes.
- `FeatureIngestFailures`: monitors sustained increases in `features.ingest.error` / `features.ingest.dlq`.

Alerts should point to:

- Dashboards: Grafana folder `MLOps / Features`.
- Runbooks: `docs/FEATURE_DASHBOARDS.md`, `docs/MLOPS_RUNBOOKS.md`.

## Dashboards

Include the following panels:

1. Freshness p95 per feature set.
2. Histogram of lag distribution.
3. Correlated DLQ/retry rates to identify ingestion incidents.

Document panel details and owners in `docs/FEATURE_DASHBOARDS.md`.
