# ML Services Dashboards

Baseline Grafana dashboards to monitor the Python ML services. These definitions assume OTEL → Prometheus metrics using the naming produced by the `instrument_fastapi` middleware (`http_server_duration_ms` counter emitted as histogram) and standard OTEL semantic conventions.

## Prerequisites

- Metrics pipeline exports HTTP server metrics with labels: `service`, `route`, `method`, and `status_code`.
- Safety Gate requests use route `/analyze`; Scribe draft requests use `/draft`.
- Dashboards target the `ml-dev` Prometheus data source (adjust as needed).

## Recommended panels

| Panel | Query (PromQL) | Notes |
| --- | --- | --- |
| Safety Gate latency p50 | `histogram_quantile(0.5, sum(rate(http_server_duration_ms_bucket{service="safety-gate", route="/analyze"}[$__interval])) by (le))` | Shows median latency over the selected interval. |
| Safety Gate latency p95 | `histogram_quantile(0.95, sum(rate(http_server_duration_ms_bucket{service="safety-gate", route="/analyze"}[$__interval])) by (le))` | Track tail latency spikes; alert when >1500 ms. |
| Safety Gate error rate | `sum(rate(http_server_requests_total{service="safety-gate", route="/analyze", status_code=~"5.."}[$__interval])) / sum(rate(http_server_requests_total{service="safety-gate", route="/analyze"}[$__interval]))` | Displays % of requests failing due to server errors. |
| Safety Gate throughput | `sum(rate(http_server_requests_total{service="safety-gate", route="/analyze"}[$__interval]))` | Requests per second; overlay deployment markers. |
| Scribe draft latency p50 | `histogram_quantile(0.5, sum(rate(http_server_duration_ms_bucket{service="scribe", route="/draft"}[$__interval])) by (le))` | Median LLM response latency. |
| Scribe draft latency p95 | `histogram_quantile(0.95, sum(rate(http_server_duration_ms_bucket{service="scribe", route="/draft"}[$__interval])) by (le))` | Tail latency; alert if >10 s. |
| Scribe draft error rate | `sum(rate(http_server_requests_total{service="scribe", route="/draft", status_code=~"5.."}[$__interval])) / sum(rate(http_server_requests_total{service="scribe", route="/draft"}[$__interval]))` | Server error percentage. |
| Scribe throughput | `sum(rate(http_server_requests_total{service="scribe"}[$__interval]))` | Total requests per second (all endpoints). |
| Booking latency p95 | `histogram_quantile(0.95, sum(rate(booking_http_duration_ms_bucket{route="/booking/appointments"}[$__interval])) by (le))` | Booking handler tail latency; target < 1500 ms. |
| Booking backpressure (rate) | `rate(booking_http_backpressure_total[$__interval])` | Highlights sustained 429 responses from concurrency caps. |
| Booking event DLQ | `rate(booking_event_dlq_total[$__interval])` | Monitors DLQ throughput; sustained >0 suggests retry/backoff tuning. |
| GP Connect conflicts | `rate(gp_connect_create_conflict_total[$__interval])` | Track frequency of 409 conflicts returned by GP Connect. |

Adjust label names if your exporter uses different label keys (e.g., `http_route`, `http_status_code`).

## Grafana JSON snippets

Create a new dashboard in Grafana and add a panel per metric. Example panel JSON for the Scribe p95 latency graph:

```json
{
  "title": "Scribe /draft latency p95",
  "type": "timeseries",
  "datasource": "ml-dev",
  "targets": [
    {
      "refId": "A",
      "expr": "histogram_quantile(0.95, sum(rate(http_server_duration_ms_bucket{service=\"scribe\", route=\"/draft\"}[$__interval])) by (le))"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "ms",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green", "value": null },
          { "color": "orange", "value": 5000 },
          { "color": "red", "value": 10000 }
        ]
      }
    }
  }
}
```

Repeat for other panels, adjusting titles, queries, and units.

## Import instructions

1. Save the panel definitions or complete dashboard JSON locally.
2. In Grafana, navigate to **Dashboards → Import**.
3. Paste the JSON or upload the file.
4. Set the data source (e.g., `ml-dev`) when prompted.
5. Share the dashboard link in the ML Ops runbook and set up alerts for latency/error thresholds once real metrics are flowing.

## Next steps

- Once real OTEL exporters are wired, validate the metric names and adjust queries.
- Configure alert rules (Grafana Alerting or Prometheus Alertmanager) for:
  - Safety Gate p95 > 1500 ms for 5 minutes.
  - Scribe p95 > 10 s for 5 minutes.
  - Error rate > 1% sustained for 10 minutes.
- Add panels for resource utilization (CPU/memory) from node_exporter or container metrics.
