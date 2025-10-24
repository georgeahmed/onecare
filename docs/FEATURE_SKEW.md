# Feature Training/Serving Skew Detection

This guide describes how to measure and alert on training-serving skew for critical feature sets.
The tooling reuses the same PSI (Population Stability Index) and histogram comparisons used by the
ML pipelines, providing fast feedback when online distributions drift from the offline training
baseline.

## CLI (`scripts/feature_store/skew.js`)

```
node scripts/feature_store/skew.js \
  --offline data/offline/triage-core.parquet.jsonl \
  --online data/online/triage-core.sample.jsonl \
  --feature-set triage-core \
  --fields acuity,compositeScore \
  --bins 20 \
  --threshold 0.1
```

Inputs are NDJSON snapshots (one record per line) produced by offline batch exports and online
sampling jobs. The script prints a JSON summary containing PSI per field and exits with status code
`2` when any field breaches the threshold.

Key options:

| Flag | Description | Default |
|------|-------------|---------|
| `--offline` | Offline/training snapshot in JSONL form | required |
| `--online` | Online/serving snapshot | required |
| `--feature-set` | Feature set to filter (`triage-core`, `acuity-signal`, …) | required |
| `--fields` | Comma-separated list of numeric fields to compare | required |
| `--bins` | Histogram bins for PSI computation | `10` |
| `--threshold` | PSI threshold marking a breach | `0.2` |

Example output:

```json
{
  "featureSet": "triage-core",
  "offlineSamples": 5000,
  "onlineSamples": 1200,
  "bins": 10,
  "threshold": 0.1,
  "summaries": [
    { "field": "acuity", "psi": 0.0341, "status": "ok" },
    { "field": "compositeScore", "psi": 0.1423, "status": "breach" }
  ]
}
```

## Automation Hooks

1. **Offline capture** — After each model training job, export JSONL snapshots (per feature set)
   alongside the training artifacts.
2. **Online sampling** — Schedule sampling jobs (e.g., hourly) to export a fixed-size reservoir of
   recent serving requests. Ensure records contain `featureSet`, `entityId`, `payload`, and `asOf`.
3. **CI/Monitoring** — Run the skew checker as part of the weekly evaluation and push PSI values to
   Prometheus (use the JSON output for scrape targets). Alert when PSI > threshold for two
   consecutive runs.
4. **Dashboards** — Plot PSI by field (`feature_skew_psi{featureSet="triage-core",field="acuity"}`)
   and overlay the model deployment timestamps.

## Remediation Steps

- Confirm whether the drift is expected (e.g., new population) or a regression in ingestion.
- If unexpected, trigger a model retraining pipeline with the updated offline distributions.
- Investigate ingestion changes (schema updates, source bugs) that could have skewed the online
  population.
- Capture notes in the MLOps drift log; include PSI history, affected feature sets, and resolution.

## Integration Checklist

- [ ] Offline + online export automation in place (weekly minimum).
- [ ] PSI metrics scraped and visualised in the MLOps dashboard.
- [ ] Alert configured for PSI breaches with ownership (MLOps rotation + Data Engineering on-call).
- [ ] Runbook updated with remediation contacts and escalation path.

