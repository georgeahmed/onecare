# Service-Level Objectives

This document describes the current SLO catalogue across OneCare services. A concise summary lives in `docs/SLOs.md`; refer back here for detailed measurement guidance, burn-rate policies, and runbook links. Review and reconfirm the SLO set every quarter or whenever a material architecture change lands.

## Orchestrator & Safety Gate (Triage)

| Dimension | Objective | Measurement | Error Budget & Response |
|-----------|-----------|-------------|-------------------------|
| Latency | p95 ≤ **1.5 s** for `/safety-check` (end-to-end, HTTP ingress ➝ response) | `histogram_quantile(0.95, sum(rate(http_server_duration_ms_bucket{service="orchestrator",route="/safety-check"}[5m])) by (le))` | 5 % of requests may exceed 1.5 s per 30-day window. Breach: trigger incident review, consider enabling degraded mode (reduced feature set) until cleared. |
| Error Rate | ≤ **0.5 %** 5xx/application failures over rolling 30 min | `rate(http_server_errors_total{service="orchestrator",route="/safety-check"}[5m]) / rate(http_server_requests_total{service="orchestrator",route="/safety-check"}[5m])` | 0.5 % of requests per 30-day window. Two consecutive burn windows ⇒ page owner, initiate rollback or feature flag mitigation. |
| Uptime | Monthly availability ≥ **99.5 %** | Success vs total requests (`http_server_requests_total`) + synthetic probe (`blackbox_success`) | 0.5 % (~3.65 h/mo). Breach requires RCA before next feature deployment. |
| Readiness Stability | ≤ **3 readiness probe flaps** per hour | `rate(kube_probe_success{probe="readiness",service="orchestrator"}[5m])` vs failure count | >3/h triggers alert + scaling review (resource pressure / dependency outage). |

## Booking Service

| Dimension | Objective | Measurement | Error Budget & Response |
|-----------|-----------|-------------|-------------------------|
| Search Latency | p95 ≤ **800 ms** for `POST /booking/search` | `histogram_quantile(0.95, sum(rate(booking_http_duration_ms_bucket{route="/booking/search"}[5m])) by (le))` | 5 % over 30 days. Burn-rate > 2.0 over 1 h ⇒ page booking on-call; consider bumping GP Connect timeout/backoff. |
| Create Latency | p95 ≤ **1.2 s** for `POST /booking/appointments` | same histogram expression for route `/booking/appointments` | Same as above; if conflict retries dominate, review provider availability or throttle concurrency. |
| Error Rate | ≤ **1 %** non-4xx responses | `rate(http_server_errors_total{service="booking"}[5m]) / rate(http_server_requests_total{service="booking"}[5m])` | 1 % budget / 30 days. >1% for 15 m triggers alert and auto-enables conflict refresh instrumentation. |
| DLQ Backlog | < **100 messages** sustained < **15 m** | `max_over_time(broker_dlq_pending{topic=~"booking.*"}[15m])` | If backlog ≥100 for >15 m page SRE + booking; drain and run post-mortem. |

## ICS Hub & Automation

| Dimension | Objective | Measurement | Error Budget & Response |
|-----------|-----------|-------------|-------------------------|
| Routing Latency | p95 ≤ **750 ms** (receive ➝ downstream POST) | `histogram_quantile(0.95, sum(rate(ics_routing_latency_ms_bucket[5m])) by (le))` | 5 % budget. >1 burn rate for 1 h triggers routing investigation. |
| Ack Latency | p95 ≤ **500 ms** | `histogram_quantile(0.95, sum(rate(ics_ack_latency_ms_bucket[5m])) by (le))` | 5 % budget. Two consecutive burns ⇒ escalate to downstream provider contact. |
| Automation Task Lag | 95 % tasks published within **2 min** of trigger | `histogram_quantile(0.95, sum(rate(automation_publish_latency_ms_bucket[5m])) by (le))` | 5 % budget. Sustained breach requires scaling automation workers. |
| DLQ Growth | < **50** net new DLQ messages over 10 m | `increase(broker_dlq_pending{topic=~"ics.*"}[10m])` | >50 triggers alert; run DLQ replay + purge procedure. |

## Analytics Pipeline

| Dimension | Objective | Measurement | Error Budget & Response |
|-----------|-----------|-------------|-------------------------|
| Feature Materialiser SLA | p95 ≤ **120 s** per run | `histogram_quantile(0.95, sum(rate(feature_views_duration_ms_bucket[15m])) by (view, le))` | 5 % budget. Breach ⇒ queue rerun + inspect upstream data freshness. |
| Job Freshness | < **30 m** lag between scheduled run and completion | Compare `time() - last_success_timestamp` exported by materialiser | 30 m budget. Alert if `>1800 s` for 10 m. |

## Telephony & Portal

| Dimension | Objective | Measurement | Error Budget & Response |
|-----------|-----------|-------------|-------------------------|
| WebRTC Session Setup | p95 ≤ **4 s** (offer ➝ media established) | `histogram_quantile(0.95, sum(rate(telephony_session_setup_ms_bucket[5m])) by (le))` | 5 % budget. Breach triggers network diagnostics + STUN/TURN failover. |
| Call Failure Rate | ≤ **2 %** failed sessions per 30 m | `rate(telephony_session_failed_total[5m]) / rate(telephony_session_started_total[5m])` | 2 % budget. Two adjacent burn windows page telephony / network SRE. |

## Global Reliability Indicators

- **Readiness Flaps**: For every workload, enforce ≤3 readiness probe failures/hour. Shared alert rule monitors `increase(kube_pod_container_status_ready{condition="false"}[1h])`.
- **Error Budgets**: Track 4-hour and 30-day rolling burn rates. Alerts fire when the fast burn (1 h / 2 %) or slow burn (6 h / 5 %) exceeds budget, mirroring Google SRE multi-burn patterns.
- **DLQ Hygiene**: Keep aggregate DLQ across all topics <250 messages. Purge and archive via `scripts/ops/purge-dlq.sh` as part of weekly operations.

## Measurement & Instrumentation Notes

- All latency SLOs rely on histogram metrics emitted by services (e.g., `booking_http_duration_ms_bucket`). Ensure OTEL exporters or Prometheus scrapes include histogram buckets with `le` labels.
- Error-rate calculations include server-side failures (`status >= 500`) plus application-level errors surfaced via `booking_http_requests_total{outcome="error"}`.
- Readiness probes are instrumented via Kubernetes; ensure `kube-state-metrics` is scraped to expose `kube_pod_container_status_ready`.
- DLQ metrics come from JetStream exporter (`broker_dlq_pending` gauge) and application-specific counters. Configure the exporter to include per-topic labels.

## Reporting & Reviews

- Grafana: dashboards named `SLO • <Service>` should visualise attainment, remaining error budget, and burn rate. Include quick links to runbooks noted in the alert annotations.
- Weekly reliability review: summarise budget consumption, active burn alerts, and completed purge operations. Attach charts or query links.
- Change management: update this document and `docs/SLOs.md` whenever thresholds, metrics, or runbooks change. Coordinate alert updates via PRs touching `infra/monitoring/alerts/*.yaml`.
