# MLOps SLOs & Alerting

This document defines the reliability targets for ML inference services and links alerting rules to runbooks.

## Service Level Objectives

| Metric | Target | Measurement | Notes |
| --- | --- | --- | --- |
| p95 latency | ≤ 800 ms over 5 min windows | Prometheus `histogram_quantile` | Measured per ingress service and shadow comparison. |
| Error rate | < 1% 5xx over 10 min | `sum(rate(http_requests_total{code=~"5.."})) / sum(rate(http_requests_total))` | Includes circuit breaker drops. |
| Throttle rate | < 2% 503/`Retry-After` | Observed via structured log counter | Ensure backpressure yields 503 not 500. |
| Shadow agreement | ≥ 0.985 during trials | `shadowEvaluator.metrics()` | Only evaluated when shadowing is enabled. |
| OOM/restarts | 0 unexpected restarts per hour | `kube_pod_container_status_restarts_total` | Alert on consecutive restarts. |

Track burn-down in `docs/observability/SLOs.md` and attach to weekly ops review.

## Alert Rules

- Managed under `infra/monitoring/ml_alerts.yml`.
- Alert severities:
  - **page**: sustained p95 > 900 ms for 10 min, or error rate > 3% for 5 min.
  - **ticket**: throttle > 5% for 15 min, or more than 3 restarts within 10 min.
- Alerts link to:
  - Rollout/rollback playbook (`docs/MLOPS_ROLLOUTS.md`).
  - Shadow investigation guide (`docs/MLOPS_SHADOW.md`).
  - Model registry handoff (`docs/MODEL_REGISTRY.md`).

## On-call & Escalation

- Primary rotation: `mlops@onecare` (PagerDuty schedule `MLOps-Primary`).
- Secondary: platform SRE (PagerDuty schedule `Platform-Secondary`).
- Escalate to ML engineering lead if SLO burn rate exceeds 2× budget over 6 h window.

## Validation

1. Run `make alert-test` (Prometheus unit tests) to ensure rule syntax passes.
2. Simulate alert with `amtool alert query` against the staging Alertmanager using `for` intervals.
3. Confirm dashboards highlight the same metrics; update links as dashboards evolve.
