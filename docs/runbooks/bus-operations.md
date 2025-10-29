# Bus Operations Runbook

## Overview
- This runbook covers day-two operations for the event bus (NATS JetStream) powering orchestrator and companion services.
- Incidents typically fall into four buckets: connection storms, authentication/credential failures, DLQ bursts, and consumer backlog/backpressure.
- Consult this runbook alongside the NATS resilience guide (`docs/runbooks/nats-bus-resilience.md`) and service-specific playbooks.

## Dashboards & Metrics
- **Primary dashboard**: `Dashboards/Bus` (Grafana folder) visualises `bus_nats_publish_latency_ms`, `bus_nats_handler_latency_ms`, connection counters (`bus_reconnect_events_total`, `bus_disconnect_events_total`), and DLQ throughput.
- **Critical metrics**:
- `bus_reconnect_delay`, `bus_reconnect_events_total`, `bus_disconnect_events_total`: connection churn
  - `bus_msg_too_large_total`, `bus_msg_compressed_total`: payload policy enforcement
  - `bus_quota_block_total`, `bus_tenant_throughput_total`: tenant quotas
  - `bus_partition_hot_key_total`: hot key detection
  - `bus_nats_pending_lag`, `bus_nats_dlq_published_total`, `bus_nats_dlq_errors_total`
- **Alert thresholds (suggested)**:
- Connection storms: `bus_reconnect_events_total` > 5/min or `bus_reconnect_delay` p95 > 5s
  - DLQ spike: `bus_nats_dlq_published_total` > 100/min sustained for 5 minutes
  - Pending lag: `bus_nats_pending_lag` > 5_000 for 3 consecutive scrapes
  - Hot keys: `bus_partition_hot_key_total` > 10/min (investigate tenant/topic skew)

## Incident Playbooks

### Connection Storm / Broker Disconnect
**Symptoms**: `/ready` returning 503, spikes in `bus_reconnect_events_total`, logs showing “failed to publish audit event” or “connection closed”.

**Checklist**:
1. Confirm broker availability (NATS monitoring, infra alerts). If cluster is unstable, escalate to DevOps (Slack `#infra-p1`).
2. Check credential validity. If JWT/creds expired, rotate secrets (`NATS_CREDS_PATH`) and call `refreshNatsBusSecurity()` (or redeploy).
3. Increase jitter/backoff temporarily via `NATS_RECONNECT_BASE_DELAY_MS`/`MAX_DELAY_MS` to ease reconnect pressure.
4. Verify TLS certs (`NATS_TLS_*`). Failed handshakes show as repeated disconnect events with errors in service logs.
5. Once broker stabilises, ensure readiness recovers (pending lag clears) before closing the incident.

### DLQ Spike / Poison Messages
**Symptoms**: `bus_nats_dlq_published_total` jumping, `bus_nats_dlq_poison_total` incrementing.

**Checklist**:
1. Inspect DLQ payloads via `node scripts/dlq-requeue.js --peek broker.dlq` or the Grafana DLQ table. Verify `retryable` flag.
2. If messages are retryable, likely a transient downstream outage. Confirm consumer health and coordinate resume.
3. For poison messages (validation/auth failures), review `payloadRef.code` / `payloadRef.reason` and notify the owning feature team.
4. Watch `bus_msg_too_large_total` — if high, re-review publishers for large blob use; route large binaries to object storage.
5. Once root cause is addressed, requeue selected DLQ entries with `scripts/dlq-requeue.js` or purge if obsolete.

### Consumer Lag / Backpressure
**Symptoms**: `bus_nats_pending_lag` above threshold, readiness failing, `bus_nats_backpressure_events_total` incrementing.

**Checklist**:
1. Identify which topics are lagging (Grafana graph). Cross-reference with tenant throughput metrics.
2. Ensure consumers are running (`kubectl get pods`, service logs). Restart hung consumers as needed.
3. Scale consumer replicas or increase resources (CPU/memory) if throughput has permanently increased.
4. Review partition distribution (`bus_partition_hot_key_total`). Consider increasing `NATS_PARTITIONS` or adjusting key hashing.
5. If upstream producers flood the bus, coordinate rate reductions or enable stricter tenant quotas.

### Authentication / TLS Failures
**Symptoms**: Logs: “TLS is required”, “authorization violation”, metrics show connection oscillation.

**Checklist**:
1. Validate secrets in the secret store; ensure new `.creds` is deployed and path matches `NATS_CREDS_PATH`.
2. For TLS, confirm CA/cert/key files exist and matches broker CA. Renew certs via automation (refer to security runbook).
3. Redeploy services (or run `refreshNatsBusSecurity()` if supported) to load new credentials.
4. Monitor `bus_reconnect_events_total` to confirm stable reconnects.

## Escalation Matrix
- P0 (system outage, sustained DLQ growth): @on-call backend, DevOps on-call, escalate to platform lead within 15 minutes.
- P1 (degraded but still serving): backend on-call, notify feature owners for impacted topics.
- Security/TLS issues: involve security team if cert compromise suspected.

## Post-Incident Review Checklist
- Capture timeline of metrics & actions.
- Note config changes (backoff adjustments, quota overrides) and revert after stability.
- File follow-up tasks: e.g., adjust thresholds, automate rotation.
