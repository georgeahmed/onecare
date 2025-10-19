# SLO Overview

This page summarises the current service-level objectives. Each entry links to the detailed specification in `docs/observability/SLOs.md`, the corresponding Prometheus alert rule, and the runbook responders should follow when a breach occurs.

| Service | Objective | Metric / Query | Alert Rule | Runbook |
|---------|-----------|----------------|------------|---------|
| Orchestrator (Safety Gate) | p95 latency ≤ **1.5 s** | `histogram_quantile(0.95, sum(rate(http_server_duration_ms_bucket{service="orchestrator",route="/safety-check"}[5m])) by (le))` | `infra/monitoring/alerts/slo-orchestrator.yaml` (`OrchestratorLatencyBurn`) | `docs/runbooks/oncall.md#orchestrator-latency` |
| Orchestrator | Error rate ≤ **0.5 %** | `rate(http_server_errors_total{service="orchestrator"}[5m]) / rate(http_server_requests_total{service="orchestrator"}[5m])` | `infra/monitoring/alerts/slo-orchestrator.yaml` (`OrchestratorErrorBudget`) | `docs/runbooks/oncall.md#error-budget-response` |
| Booking | Search p95 ≤ **800 ms** | `histogram_quantile(0.95, sum(rate(booking_http_duration_ms_bucket{route="/booking/search"}[5m])) by (le))` | `infra/monitoring/alerts/slo-booking.yaml` (`BookingSearchLatencyBurn`) | `docs/runbooks/oncall.md#booking-latency` |
| Booking | DLQ backlog < **100** messages < **15 m** | `max_over_time(broker_dlq_pending{topic=~"booking.*"}[15m])` | `infra/monitoring/alerts/slo-booking.yaml` (`BookingDlqGrowth`) | `docs/runbooks/oncall.md#dlq-remediation` |
| ICS Hub | Ack p95 ≤ **500 ms** | `histogram_quantile(0.95, sum(rate(ics_ack_latency_ms_bucket[5m])) by (le))` | `infra/monitoring/alerts/slo-ics.yaml` (`IcsAckLatencyBurn`) | `docs/runbooks/oncall.md#ics-acknowledgements` |
| ICS Hub | DLQ growth < **50** messages / 10 m | `increase(broker_dlq_pending{topic=~"ics.*"}[10m])` | `infra/monitoring/alerts/slo-ics.yaml` (`IcsDlqGrowth`) | `docs/runbooks/oncall.md#dlq-remediation` |
| Automation | Task publish p95 ≤ **2 min** | `histogram_quantile(0.95, sum(rate(automation_publish_latency_ms_bucket[5m])) by (le))` | `infra/monitoring/alerts/slo-ics.yaml` (`AutomationLatencyBurn`) | `docs/runbooks/oncall.md#automation-latency` |
| Analytics | Materialiser p95 ≤ **120 s** | `histogram_quantile(0.95, sum(rate(feature_views_duration_ms_bucket[15m])) by (view, le))` | `infra/monitoring/alerts/slo-analytics.yaml` (`AnalyticsMaterialiserLatency`) | `docs/runbooks/oncall.md#analytics-materialiser` |
| Telephony | WebRTC setup p95 ≤ **4 s** | `histogram_quantile(0.95, sum(rate(telephony_session_setup_ms_bucket[5m])) by (le))` | `infra/monitoring/alerts/slo-telephony.yaml` (`TelephonySessionLatency`) | `docs/runbooks/oncall.md#telephony-webrtc` |
| Platform | Readiness flaps ≤ **3** / h | `increase(kube_pod_container_status_ready{condition="false"}[1h])` | `infra/monitoring/alerts/slo-platform.yaml` (`ReadinessFlapBudget`) | `docs/runbooks/oncall.md#readiness-instability` |

Refer to the detailed SLO write-up (`docs/observability/SLOs.md`) for metric derivations, burn-rate thresholds, and escalation criteria. Update this summary whenever you add, modify, or retire an SLO.
