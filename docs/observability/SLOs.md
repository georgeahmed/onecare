# Service-Level Objectives

The following SLOs provide initial guardrails for the orchestrator/triage and scribe flows. They should be reviewed quarterly and refined as production telemetry becomes available.

## Triage (Safety Gate) Latency

- **Objective**: 95% of `/safety-check` requests complete within **1.5 seconds** measured at the orchestrator boundary (end-to-end: request arrival → response sent).
- **Measurement**: OTEL traces or HTTP server histogram (`http.server.duration_ms`) aggregated by the OTEL Collector.
- **Error Budget**: 5% of requests may exceed 1.5s over a 30-day window. Breaching the budget triggers an incident review and temporary feature freeze until remediated.

## Scribe (Draft Generation) Latency

- **Objective**: 95% of `/draft` requests complete within **10 seconds** (LLM + post-processing). This accounts for external LLM round trips.
- **Measurement**: Same as above (OTEL traces / HTTP metrics).
- **Error Budget**: 5% > 10s over 30 days. On breach, enable fallback mode (`SCRIBE_FALLBACK_MODE=transcript`) until latency is restored.

## Triage Error Rate

- **Objective**: Maintain orchestrator `/safety-check` error rate ≤ **0.5%** (5xx + application errors) over rolling 30 minutes.
- **Measurement**: `rate(http_server_errors_total{route="/safety-check"}[5m]) / rate(http_server_requests_total{route="/safety-check"}[5m])`.
- **Error Budget**: 0.5% of requests may error per 30-day window. Sustained breaches (two consecutive burn windows) trigger canary rollback or traffic shifting to degraded mode.

## DLQ Backlog (Analytics & Booking)

- **Objective**: Keep per-topic DLQ backlog under **100 messages** with no sustained growth > **15 minutes**.
- **Measurement**: Prometheus gauge `broker_dls_messages_total` (or JetStream `pending`) exported via `@onecare/bus`.
- **Error Budget**: Tolerate backlog spikes of ≤100 for ≤15 minutes. Longer spikes require paging SRE + owning team to drain and address root cause.

## Service Uptime

- **Objective**: Combined orchestrator HTTP uptime of **99.5%** monthly. Uptime is defined as success responses (`2xx`, `4xx` that are client errors) vs. total requests.
- **Measurement**: Access logs and health checks monitored via collector + synthetic probes.
- **Error Budget**: 0.5% downtime (~3.65 hours/month). Breaches require RCA and action plan before new feature deploys.

## Readiness Stability

- **Objective**: No more than **3 readiness probe flaps** per service over any rolling hour.
- **Measurement**: `increase(probe_success{probe="readiness",service="$SERVICE"}[1h])` combined with failure counts exported by `kube-state-metrics`.
- **Error Budget**: More than three flaps/hour triggers alert + investigation (resource saturation, dependency outages, rollout issues).

## Tracking & Reporting

- Dashboards (Grafana) should plot SLO attainment and remaining error budget.
- Incidents and burn-down tracked in the reliability weekly report.
- Update this document when targets change or additional SLOs are introduced (e.g., error rate, queue depth).
- Alert rule definitions live in `infra/monitoring/alerts/`; update both the rule and this document if thresholds or burn windows change.
