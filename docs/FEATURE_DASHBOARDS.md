# Feature Health Dashboards

Dashboards live in Grafana under **MLOps / Features**. Each panel below includes a short description, owner, and linked runbook.

## Panels

Panel | Description | Thresholds | Runbook
--- | --- | --- | ---
Freshness p95 (per feature set) | Queries `features_freshness_lag_ms_bucket` and displays the 95th percentile lag for selected feature sets. | `triage-core`: ≤ 120s, `acuity-signal`: ≤ 180s | `docs/FEATURE_FRESHNESS.md`
Ingestion retries / DLQ | Stacked bars of `features.ingest.retry` and `features.ingest.dlq`. Correlate with alerts to spot systemic failures. | Retries > 20/min or DLQ > 5/min triggers investigation. | `docs/MLOPS_RUNBOOKS.md`
Null rate | Percent of null/empty feature values captured in the offline store (via PSI job). | > 5% sustained for 30 mins requires data quality review. | Data Ops runbook (link TBD)
Throughput | `features.ingest.ok` per minute, split by feature set. | Sudden drops or spikes should be triaged alongside DLQ metrics. | `docs/MLOPS_RUNBOOKS.md`
Drift metrics | PSI / Jensen-Shannon scores from offline comparison jobs. | PSI > 0.3 for two consecutive runs escalated to ML lead. | Model evaluation playbook (link TBD)

## Ownership & Alerts

- Primary: MLOps (PagerDuty `MLOps-Primary`)
- Secondary: Data Engineering (`data-eng-oncall`)
- Alerts reference `infra/monitoring/feature_alerts.yml` and `infra/monitoring/ml_alerts.yml`.

## Adding New Panels

1. Export the panel JSON and commit to `docs/observability/dashboards/`.
2. Document the panel here with thresholds and runbook references.
3. Update alert rules if new SLOs are introduced.
