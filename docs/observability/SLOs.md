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

## Service Uptime

- **Objective**: Combined orchestrator HTTP uptime of **99.5%** monthly. Uptime is defined as success responses (`2xx`, `4xx` that are client errors) vs. total requests.
- **Measurement**: Access logs and health checks monitored via collector + synthetic probes.
- **Error Budget**: 0.5% downtime (~3.65 hours/month). Breaches require RCA and action plan before new feature deploys.

## Tracking & Reporting

- Dashboards (Grafana) should plot SLO attainment and remaining error budget.
- Incidents and burn-down tracked in the reliability weekly report.
- Update this document when targets change or additional SLOs are introduced (e.g., error rate, queue depth).
