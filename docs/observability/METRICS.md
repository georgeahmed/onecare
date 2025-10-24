# Metrics Pipeline Hardening

This guide documents the conventions and safeguards that keep our metrics useful, low-cardinality, and cost-effective.

## Prometheus Configuration

The compose stack now exposes Prometheus on `http://localhost:9090` via the `prometheus` service in `docker-compose.yml`. Configuration lives in `infra/monitoring/prometheus.yml` and includes:

- **Selective scraping** of the OTEL collector (`otel-collector:8888` for collector health) and application exporters (`orchestrator:3001/metrics`, `safety-gate:8081/metrics`, `ics-hub:7100/metrics`, `analytics:9400/metrics`, `scribe:8082/metrics`). Telephony ingress metrics (`telephony_http_*`) can be added by pointing Prometheus at the telephony service when it is deployed.
- **Label dropping** for sensitive or high-cardinality labels (`user`, `email`, `token`, `traceId`, etc.).
- **Histogram focus**: keeps `http_server_duration_{bucket,sum,count}`, `http_server_requests_total`, `http_server_errors_total`, plus booking, ICS, and Safety Gate families (`booking_http_*`, `gp_connect_*`, `booking_event_*`, `ics_routing_latency_ms_*`, `ics_ack_latency_ms_*`, `ics_backpressure_wait_ms_*`, `safety_gate_request_latency_seconds_*`, `safety_gate_requests_total`) alongside analytics ingest metrics (`analytics_ingest_lag_ms_*`, `analytics_sink_latency_ms_*`) so dashboards surface latency, upstream reliability, and DLQ throughput without excess noise.
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
- Booking-specific widgets:
  - `rate(booking_http_backpressure_total[5m])` to spot when concurrency caps are hit.
  - `histogram_quantile(0.95, sum(rate(booking_http_duration_ms_bucket[5m])) by (le, route))` to confirm p95 latency budgets.
  - `rate(booking_event_dlq_total[5m])` to watch DLQ throughput; sustained non-zero rates warrant retry/backoff tuning.
- ICS Hub:
  - `histogram_quantile(0.95, sum(rate(ics_routing_latency_ms_bucket[5m])) by (le))` and the companion `ics_ack_latency_ms_bucket` histogram for routing/ack SLOs.
  - `rate(ics_backpressure_overload_total[5m])` and `sum(ics_backpressure_wait_ms_bucket)` to monitor concurrency guardrails.

Before enabling production alerts, promote the Prometheus configuration to shared infrastructure (e.g., Helm chart) and add remote_write to long-term storage.
