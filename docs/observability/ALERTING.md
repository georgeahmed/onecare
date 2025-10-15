# Alert Hygiene & On-Call Guide

This playbook explains how alerts are grouped, deduplicated, and triaged across the observability stack. It complements the Prometheus/Loki configuration shipped in compose and should be mirrored in staging/production infrastructure.

## Alert Dedupe & Grouping

Alertmanager (or Grafana Alerting) must normalise labels so duplicate events collapse into a single incident:

- **Group by**: `service`, `severity`, `slo`, `team`. Avoid high-cardinality labels such as `pod`, `instance`, or `correlationId`.
- **Timing knobs**:
  - `group_wait: 30s` – buffer initial fire to combine simultaneous triggers.
  - `group_interval: 5m` – aggregate repeated alerts for the same group.
  - `repeat_interval: 2h` – resend if the alert is still active after mitigation window.
- **Label scrubbing**: ensure exporters drop volatile labels (already enforced in `infra/monitoring/prometheus.yml`) so dedupe stays effective.

Record these values in Helm values or Terraform modules when deploying to shared clusters.

## Silence Windows

Use scheduled silences for maintenance to prevent alert floods while keeping monitoring data intact.

1. Define maintenance events in Opsgenie/PagerDuty at least 24h ahead.
2. Apply Alertmanager silences scoped to `service=<target>` and `severity` for the maintenance window. Include a comment with the change ID.
3. Never silence `severity=critical` without a live fallback; prefer downgrading to `warning` if the risk is acceptable.
4. After the window, remove silences and verify alerts re-register within 5 minutes.

Track silences in the change log and review weekly to avoid stale entries.

## Runbook Links in Alert Templates

The alert templates in `docs/observability/alerts/*.yaml` include a `runbook` annotation. Populate the value with a URL pointing to the relevant section of this document or service-specific runbooks:

- Triage latency: `https://onecare/runbooks/triage-latency`
- Scribe backlog: `https://onecare/runbooks/scribe-backlog`
- On-call response: `https://onecare/runbooks/oncall-protocol`

Use the same runbook slug in Grafana dashboards to allow one-click pivoting from panels to playbooks.

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
