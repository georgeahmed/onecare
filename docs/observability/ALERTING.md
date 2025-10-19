# Alert Hygiene & On-Call Guide

This playbook explains how alerts are grouped, deduplicated, and triaged across the observability stack. It complements the Prometheus/Loki configuration shipped in compose and should be mirrored in staging/production infrastructure. A summary of active SLOs/alerts lives in `docs/SLOs.md`; service-specific response steps are documented in `docs/runbooks/oncall.md`.

## Alert Dedupe & Grouping

Alertmanager (or Grafana Alerting) must normalise labels so duplicate events collapse into a single incident. The canonical rule files live in `infra/monitoring/alerts/` (converted from the templates in `docs/observability/alerts/`). Sync them into clusters via Helm/Kustomize so alert definitions remain version-controlled.

- **Group by**: `service`, `severity`, `slo`, `team`. Avoid high-cardinality labels such as `pod`, `instance`, or `correlationId`.
- **Timing knobs**:
  - `group_wait: 30s` – buffer initial fire to combine simultaneous triggers.
  - `group_interval: 5m` – aggregate repeated alerts for the same group.
  - `repeat_interval: 2h` – resend if the alert is still active after mitigation window.
- **Label scrubbing**: ensure exporters drop volatile labels (already enforced in `infra/monitoring/prometheus.yml`) so dedupe stays effective.
- **Routing**: map `severity=critical` alerts to the PagerDuty/OpsGenie on-call schedule defined in `docs/runbooks/oncall.md#incident-intake`; route `warning` to the owning team Slack channel with a 15-minute auto-escalation.

Record these values in Helm values or Terraform modules when deploying to shared clusters.

## Silence Windows

Use scheduled silences for maintenance to prevent alert floods while keeping monitoring data intact.

1. Define maintenance events in Opsgenie/PagerDuty at least 24h ahead.
2. Apply Alertmanager silences scoped to `service=<target>` and `severity` for the maintenance window. Include a comment with the change ID.
3. Never silence `severity=critical` without a live fallback; prefer downgrading to `warning` if the risk is acceptable.
4. After the window, remove silences and verify alerts re-register within 5 minutes.

Track silences in the change log and review weekly to avoid stale entries. Maintenance events must reference the relevant SLO entry (`docs/SLOs.md`) so post-maintenance reviews confirm no objective drift.

## Runbook Links in Alert Templates

Alert definitions must carry a `runbook` annotation pointing to `docs/runbooks/oncall.md` anchors. The generator templates in `docs/observability/alerts/*.yaml` show the structure; the concrete PrometheusRule manifests in `infra/monitoring/alerts/` embed the final URLs.

- Example runbook URLs:
  - Triage latency: `https://onecare/runbooks/oncall#orchestrator-latency`
  - Booking latency: `https://onecare/runbooks/oncall#booking-latency`
  - DLQ backlog: `https://onecare/runbooks/oncall#dlq-remediation`
  - ICS ack latency: `https://onecare/runbooks/oncall#ics-acknowledgements`

Use the same runbook slug in Grafana dashboards to allow one-click pivoting from panels to playbooks.

### Grafana Wiring

1. Open **Alerting → Contact points → Edit** and ensure the notification template renders the `commonAnnotations.runbook` field (e.g., include `Runbook: {{ template \"__text_value\" .CommonAnnotations.runbook }}`).
2. For Grafana dashboards, add panel links pointing to the same `https://onecare/runbooks/...` URLs so responders can jump directly from metrics to the playbook.
3. When creating alert rules in Grafana, set the **Runbook URL** field to match the alert template above; Grafana will surface it in incident view and Slack/Teams notifications.

## On-Call Expectations

| Tier | Response Time | Actions |
|------|---------------|---------|
| **L1 (SRE rotation)** | Acknowledge within 5 minutes; remediate or escalate within 15 minutes. | Verify alert in Grafana; capture correlation IDs; execute runbook steps. |
| **L2 (Service owner)** | Engage within 15 minutes of L1 escalation. | Deep dive into application logs/traces; coordinate rollback or feature flags. |
| **L3 (Vendor / Stakeholder)** | Kickoff within 1 hour if upstream dependency failure. | Liaise with vendor support; update incident status hourly. |

### On-Call Workflow

1. **Acknowledge** via PagerDuty/Opsgenie; start an incident bridge if severity ≥ high.
2. **Inspect telemetry**:
   - Logs: Grafana Explore → Loki datasource, filter by `correlationId`.
   - Metrics: Grafana dashboards or Prometheus (`http_server_duration_*` histograms).
   - Traces: Tempo/collector logs for high-latency spans captured by tail sampling.
3. **Follow Runbook**:
   - Triage latency: scale safety gate, verify upstream dependencies, evaluate failover.
   - Scribe backlog: expand worker pool, enable transcript fallback, notify clinical leads.
4. **Communicate**: post updates every 15 minutes in `#incident` channel; log actions in the incident doc.
5. **Handoff**: if unresolved past 45 minutes, escalate to L2 and note outstanding items.

### Post-Incident Tasks

- File a retrospective within 48 hours capturing telemetry dashboards and correlation IDs.
- Update runbooks if steps were missing or unclear.
- Evaluate if additional alerts or suppression rules are required.

## Alert Dashboard Checklist

When building or reviewing Grafana panels:

- Ensure every alert links to a dashboard section that visualises key SLO metrics.
- Provide variables for `service`, `env`, and `correlationId`.
- Include annotations for deployments (Git SHA) so latency regressions can be matched to changes.
- Surface Alertmanager silences and acknowledge status directly on the dashboard for situational awareness.

By adhering to these guidelines, alerts stay actionable, fatigue is reduced, and on-call engineers can respond with confidence.

## Feature View Monitoring

- **Metrics**: the feature-view materialiser exports `feature.views.run` (counter) and `feature.views.duration_ms` (histogram). Scrape them via the same OTEL/metrics exporter wiring used for other CLIs.
- **Dashboards**: add a panel showing `increase(analytics_ingest_ok_total{metricName="triage-core"}[1h])` plus a duration heatmap (`histogram_quantile(0.95, rate(analytics_ingest_lag_ms_bucket{metricName="triage-core"}[15m]))`).
- **Alerts**:
  - *Stalled job*: fire if `increase(feature_views_run_total{view="triage-core.sliding-windows"}[30m]) == 0` for `for: 10m`.
  - *Slow job*: compare the p95 duration against your SLA (e.g., `histogram_quantile(0.95, rate(analytics_ingest_lag_ms_bucket{metricName="triage-core"}[15m])) > 120000`).
- **Runbooks**: link alerts to `docs/FEATURE_VIEWS.md` and the materialiser section of this guide so on-call engineers can replay the job (`npm run feature:views -- --online`) or inspect recent runs.
