# Metrics Pipeline Hardening

This guide documents the conventions and safeguards that keep our metrics useful, low-cardinality, and cost-effective.

## Prometheus Configuration

The compose stack now exposes Prometheus on `http://localhost:9090` via the `prometheus` service in `docker-compose.yml`. Configuration lives in `infra/monitoring/prometheus.yml` and includes:

- **Selective scraping** of the OTEL collector (`otel-collector:8888`) and HTTP histogram endpoints (`:9464`) for orchestrator/analytics.
- **Label dropping** for sensitive or high-cardinality labels (`user`, `email`, `token`, `traceId`, etc.).
- **Histogram focus**: only keeps `http_server_duration_{bucket,sum,count}` metrics so dashboards stay aligned with the latency SLOs.
- **15-day retention** via the Prometheus command-line flag for easy local comparisons.

When adding new services, expose metrics on a dedicated port and whitelist the target in `static_configs`.

## Label Hygiene

| Rule | Rationale |
|------|-----------|
| No raw IDs (`userId`, `requestId`, `traceId`) | They explode cardinality and leak identifiers. |
| Use enumerated labels (`route`, `outcome`, `variant`) | Keep buckets predictable and filterable. |
| Cap dynamic labels (e.g., `error`, `status`) to a known list | Document acceptable values and enforce via validation. |
| Drop PHI/PII at the emitter | The Prometheus config defensively drops obvious patterns, but producers must still avoid emitting sensitive data. |

If a label must contain a free-form value, transform it into a bounded vocabulary (map to enums) before recording metrics.

## Histogram Standards

- For HTTP latency, emit `Histogram` metrics with buckets `[0.1s, 0.25s, 0.5s, 0.75s, 1s, 1.5s, 2s, 3s, 5s, 10s]`.
- For queue depth and sizes, prefer `Gauge` metrics with alerting thresholds rather than histograms.
- Document every histogram in the owning service README so downstream dashboards know which buckets to expect.

## Alerting & Dashboards

Prometheus is wired into Grafana by default. Suggested dashboards:

- Latency percentiles (`histogram_quantile`) filtered by `route`.
- Error-rate panels that combine log correlation IDs with metrics.
- Cardinality overview using `count_values` to ensure labels stay bounded.

Before enabling production alerts, promote the Prometheus configuration to shared infrastructure (e.g., Helm chart) and add remote_write to long-term storage.
