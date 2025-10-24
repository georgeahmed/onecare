# Online Feature Store Health & Cache Strategy

The online store serves real-time features to the Safety Gate and other ML consumers. This document explains health/readiness indicators, cache strategy, and monitoring.

## Health & Readiness

- `GET /health` (service level) should bubble up the store status.
- The online store adapter (see `packages/feature-store-online`) exposes:
  - `Health`: `status`, `checkedAt`, and `details` containing the latest hit ratio.
  - `Readiness`: boolean `ready` flag plus timestamp.
- Metrics emitted:
  - `features.online.get_total{featureSet}` – total lookups.
  - `features.online.get_hit{featureSet}`, `features.online.get_miss{featureSet}` – hit/miss counts.
  - `features.online.hit_ratio{store="in-memory"}` – rolling hit ratio, updated after each lookup.
  - `features.online.get_latency_ms_bucket` – histogram of lookup latency.

Use these metrics to drive alerts if hit ratio drops below 0.8 or p95 latency exceeds 50 ms.

## Cache Strategy

- **Primary cache TTL** derives from the feature registry (`registry.featureSets[].materialization.online.ttlSeconds`). Override per mapping if required.
- **Local cache**: keep a small LRU (≤ 5k entries) when backed by Redis to avoid thundering herds.
- **Invalidation**:
  - Upserts replace values for the same `(featureSet, entityId, asOf)`.
  - `ttlSeconds` ensures records age out automatically; monitor `purgeExpired()` counts.
- Recommended TTLs:

Feature Set | TTL | Notes
--- | --- | ---
`triage-core` | 10 minutes | Aligns with ingestion cadence.
`acuity-signal` | 15 minutes | Slightly longer due to dependent model gating.

Update this table whenever feature registry TTLs change.

## Monitoring & Alerts

- Dashboards: add panels for `features.online.hit_ratio` and latency histogram.
- Alert idea (PromQL):

```promql
features_online_hit_ratio{store="in-memory"} < 0.8
```

for 10 minutes -> ticket.

```promql
histogram_quantile(0.95, sum(rate(features_online_get_latency_ms_bucket[5m])) by (le)) > 0.05
```

for 5 minutes -> page.

## Operational Tips

- Before canary/blue-green promotions, confirm hit ratio and latency remain steady.
- During incidents, flush only affected entity keys to avoid widespread cache misses.
- For DR, rehydrate warm caches by replaying the last N minutes of ingestion events (see `docs/MLOPS_RUNBOOKS.md`).
