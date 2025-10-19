# On-Call Runbook

This runbook supports SRE and service teams responding to alerts generated from the SLO catalogue. Each section matches the `runbook` annotation shipped with the Prometheus alert rules.

## Incident Intake

1. Acknowledge the page in PagerDuty/OpsGenie within 5 minutes (severity `critical`) or 15 minutes (severity `warning`).
2. Open the linked Grafana dashboard and verify the alerting panel. Inspect the burn rate panel and the correlated traces/logs.
3. Create or update the incident channel (`#incident-<date>-<service>`). Log the alert name, environment, and start time.

## Orchestrator Latency

1. Check `SLO • Orchestrator` dashboard (`slo-orchestrator.json`) focusing on `http_server_duration_ms`.
2. Confirm whether the spike aligns with recent deployments (Git SHA annotation) or dependency latency (e.g., Safety Gate ML service).
3. Mitigation:
   - Scale orchestrator pods (`kubectl scale deploy orchestrator --replicas=<n>`).
   - Enable degraded mode by setting `ORCHESTRATOR_DEGRADED_MODE=1` via Helm override.
   - If Safety Gate is the bottleneck, inform ML team and enable request sampling for triage.
4. After stabilisation, annotate the incident with root cause and trigger a follow-up ticket if tuning is required.

## Error Budget Response

1. Identify dominant error codes via `http_server_errors_total` histogram panel.
2. If the failure originates from a downstream dependency, engage the owning team and consider traffic shifting to fallback.
3. Roll back the most recent deployment if regression suspected.
4. Update the incident record with percent budget consumed, hypotheses, and next steps.

## Booking Latency

1. Inspect `SLO • Booking` dashboard. Determine whether `search` or `create` endpoint drives the breach.
2. Validate GP Connect availability (`scripts/ops/gpconnect-health.sh` if deployed) and review conflict rate metrics.
3. Mitigation:
   - Temporarily reduce concurrency via `BOOKING_HTTP_CONCURRENCY`.
   - If GP Connect latency is external, alert the provider and enable enhanced backoff in config.
4. Once p95 recovers, schedule a retrospective to adjust caching or warmup.

## DLQ Remediation

1. Review DLQ backlog panels (`broker_dlq_pending` grouped by topic) to identify the noisy topics.
2. Inspect `infra/event-bus/dlq-runbook.md` for replay workflow. Use `apps/ics-hub/src/dev/replay.ts` or service-specific tooling.
3. After replay, execute `scripts/ops/purge-dlq.sh --dry-run` followed by `--apply` to archive and remove aged messages.
4. Record replayed correlation IDs and purge archive paths in the incident notes.

## ICS Acknowledgements

1. Confirm ack latency/burn on `SLO • ICS` dashboard. Compare `ics_ack_latency_ms` with downstream endpoint latency.
2. Verify route policy health (Vault credentials, rate limits) and inspect service logs for retries.
3. If downstream partner is at fault, fail over to standby endpoint (`infra/k8s/ingress/ics-hub-ingress.yaml`), notify partner, and track downtime.
4. Update rotation log with applied mitigations.

## Automation Latency

1. Inspect automation publish histogram; ensure worker pods are healthy.
2. Review automation queue metrics (`automation.publish.queue_depth`) to confirm backlog pressure.
3. Scale worker deployment or adjust debounce configuration if rules flood.
4. Document rule IDs responsible for spikes and coordinate with workflow owners.

## Analytics Materialiser

1. Check materialiser job dashboard for `analytics_ingest_lag_ms` (p95) and recent failures.
2. Re-run job manually (`npm run feature:views -- --online`) in staging to confirm reproducibility.
3. If upstream data missing, notify data engineering and pause dependent features.
4. After recovery, update data freshness monitoring thresholds if needed.

## Telephony Ingress

1. Inspect `telephony_http_duration_ms_bucket{path="/calls"}` for p95 > 10 s and correlate with `telephony_http_requests_total` status labels.
2. Review `telephony_reject_total` to determine whether rate limiting (`reason="rate_limit"`) or saturation (`reason="over_capacity"`) is driving errors.
3. Scale workers or relax concurrency caps if over-capacity is sustained; otherwise tune rate-limit inputs with product.
4. Engage network/IVR teams when latency is external (carrier or ASR fetch) and document mitigation in the incident log.

## Readiness Instability

1. Identify flapping pods (`kubectl describe pod -l app=<service>`). Gather kubelet events and container restart counts.
2. Check node resource utilisation; consider draining noisy nodes.
3. Verify new deployments/rollouts for the service and roll back if necessary.
4. Tune readiness probes (initial delay, failure threshold) only after root-cause is confirmed.

## Post-Incident Checklist

- Update incident timeline, root cause, and action items within 24 hours.
- File follow-up issues for long-term mitigations (capacity, retries, instrumentation gaps).
- If SLOs or alert thresholds changed during remediation, raise a PR updating `docs/observability/SLOs.md` and the relevant Prometheus rule.
- Log completed rotations, replays, and purges in the weekly reliability report.
