# Alert Templates

These templates cover the two most user-visible reliability risks called out in the SLOs: triage (safety gate) tail latency and scribe backlog growth. Each file is a PrometheusRule definition that you can adapt to Prometheus Operator, Grafana Mimir/Alerting, or cloud-managed monitoring stacks. The applied rules live in `infra/monitoring/alerts/*.yaml` and are mounted into Prometheus via docker-compose.

## Files

- `TRIAGE_LATENCY.yaml` — fires when the configured latency quantile breaches the SLO target over short (warning) and longer (critical) windows.
- `SCRIBE_BACKLOG.yaml` — tracks sustained queue depth and forward-projected growth for the scribe pipeline.
- `FEATURE_VIEWS.yaml` — ensures the feature-view materialiser runs on schedule and stays within the expected duration budget.
- Refer to [`../ALERTING.md`](../ALERTING.md) for alert hygiene, dedupe settings, and on-call response guidance. Populate the `runbook` annotation in each template with the relevant URL from that guide.

All placeholders follow the `{{PLACEHOLDER}}` pattern. Replace them with concrete values before applying:

- Metadata: `RULE_NAME`, `TEAM_LABEL`, `SERVICE_LABEL`, `ENVIRONMENT_LABEL`.
- Latency-specific knobs: `LATENCY_HISTOGRAM_METRIC`, `ROUTE_LABEL`, `SLO_QUANTILE`, window/threshold/severity placeholders, `SLO_TARGET_MS`.
- Backlog knobs: `BACKLOG_GAUGE_METRIC`, `QUEUE_LABEL`, window/threshold/severity placeholders, `PREDICTION_SECONDS`.
- Shared: `RUNBOOK_URL`, `DASHBOARD_URL`.

Commented guidance inside each file explains the intent of every section; trim comments once variables are resolved.

## Prometheus / Prometheus Operator

1. Copy the template to a temporary location and substitute placeholders (simple `envsubst` or a Helm chart value file works well).
2. Validate with `promtool check rules <file>` to catch syntax errors before deploying.
3. Apply via `kubectl apply -f <file>` (Prometheus Operator) or drop into your rules directory and reload Prometheus.
4. Wire alert labels (`team`, `severity`, `component`) to existing Alertmanager routes so the on-call rotation receives the notifications.

## Grafana (Mimir/Loki/Cloud)

- Import the rule file through **Grafana Alerting → Alert rules → New rule → Import**.
- Map the placeholders either inside Grafana’s UI editor or through Terraform/Jsonnet pipelines that render the template.
- Ensure contact points reference the correct escalation policy; Grafana keeps alerting logic but still relies on Prometheus-compatible PromQL.

## Cloud-Managed Monitoring

- **Google Cloud Monitoring**: convert the PromQL expression with Managed Service for Prometheus; use the “Import rule” or Terraform `google_monitoring_alert_policy` once placeholders are filled.
- **AWS CloudWatch / AMP**: publish the rule through Amazon Managed Service for Prometheus (AMP) or generate a CloudWatch composite alarm using `mathExpression` mirroring the PromQL. Align namespaces/labels with the exporters running in ECS/EKS.
- **Azure Monitor**: if scraping with Azure Managed Prometheus, upload the rule via ARM/Terraform; otherwise translate the logic into a Log Analytics scheduled query (KQL) using the same latency/backlog metrics.

## Validation Checklist

- Run `promtool check rules` (or platform-specific lint) after variable substitution.
- Simulate breaches locally by pushing sample metrics with `promtool test rules` or the `/api/v1/series` remote-write endpoint.
- Confirm Alertmanager / notification channels resolve the new `severity` values.

Keep `docs/observability/SLOs.md` in sync if thresholds change, and capture any deviations or mitigations in the reliability weekly report.
