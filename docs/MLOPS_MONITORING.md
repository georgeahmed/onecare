## MLOps Monitoring & Drift Hooks

This guide documents the ML-specific Prometheus metrics and golden-set sampling hooks exposed by the Safety Gate service. Use these signals to drive drift dashboards, alerting, and downstream analytics.

### Prometheus Metrics

The `/metrics` endpoint now emits the following series in addition to latency:

| Metric | Type | Description | Notes |
| --- | --- | --- | --- |
| `safety_gate_confidence_bucket` | histogram | Distribution of emergency probability scores | Buckets: 0.1→1.0 (+Inf) |
| `safety_gate_narrative_words_bucket` | histogram | Narrative word-count distribution | Buckets: 20→800 (+Inf) |
| `safety_gate_red_flag_total{flag}` | counter | Red-flag occurrences by trigger | Includes `flag="triggered"` and `flag="none"` |
| `safety_gate_decision_total{decision}` | counter | Final decision outcomes (`safe_to_continue`, `diverted`, etc.) | Lowercased |
| `safety_gate_golden_samples{source="anonymized"}` | gauge | In-memory anonymized sample count available for export | Capped by `GOLDEN_SAMPLE_BUFFER` |

Shadow metrics are appended automatically when a `ShadowEvaluator` is registered (`shadow_evaluator_*` series).

### Golden-Set Sampling

Enable sampling by defining:

- `GOLDEN_SAMPLE_RATE` (0.0–1.0, default `0`): probability per request of storing a sanitized sample.
- `GOLDEN_SAMPLE_BUFFER` (default `128`): maximum number of retained samples.
- Optional `GOLDEN_SAMPLE_TOKEN`: shared secret required to read samples via the HTTP endpoint.

Samples contain randomized IDs, timestamps, word counts, symptom counts, red-flag counts, decisions, and the rounded emergency probability. No PHI or raw text is stored.

Retrieve samples:

```bash
curl -s "https://safety-gate.staging.onecare.cloud/metrics/golden?token=${GOLDEN_SAMPLE_TOKEN}&reset=true"
```

- Omit `reset=true` to read without clearing the buffer.
- Use the returned `count` to confirm fresh data before exporting. Persist the response in an encrypted bucket and follow the privacy retention policy (`docs/security/PRIVACY_RETENTION.md`).

### Dashboards & Alerts

- Plot `safety_gate_confidence` as a histogram + trend of the mean to detect calibration drift.
- Add stacked area charts for `safety_gate_red_flag_total` and `safety_gate_decision_total` to monitor regime changes.
- Feed `safety_gate_narrative_words_bucket` into a percentile chart to confirm input distribution stability.
- The existing alert `SafetyGateShadowDisagreement` (see `infra/monitoring/ml_alerts.yml`) complements these metrics; extend alerting if the confidence distribution shifts or red-flag rates spike more than 3σ over 1 hour.

### Privacy & Retention

- Samples are anonymized and limited to aggregate metadata. Do **not** persist raw narratives or identifiers.
- Rotate `GOLDEN_SAMPLE_TOKEN` every 90 days via the secrets runbook and audit access quarterly.
- Downstream analytics jobs must delete exported samples within 30 days unless converted into an aggregated golden dataset governed by the data retention policy.
