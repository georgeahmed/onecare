# Bus Operations Runbook

## Overview
- This runbook covers day-two operations for the event bus (NATS JetStream) powering orchestrator and companion services.
- Incidents typically fall into four buckets: connection storms, authentication/credential failures, DLQ bursts, and consumer backlog/backpressure.
- Consult this runbook alongside the NATS resilience guide (`docs/runbooks/nats-bus-resilience.md`) and service-specific playbooks.

## Dashboards & Metrics
- **Primary dashboard**: `Dashboards/Bus` (Grafana folder) visualises `bus.nats.publish.latency_ms`, `bus.nats.handler.latency_ms`, connection counters, and DLQ throughput.
- **Critical metrics**:
  - `bus.reconnect.delay`, `bus.reconnect.events`, `bus.disconnect.events`: connection churn
  - `bus.msg.too_large`, `bus.msg.compressed`: payload policy enforcement
  - `bus.quota.block`, `bus.tenant.throughput`: tenant quotas
  - `bus.partition.hot_key`: hot key detection
  - `bus.nats.pending_lag`, `bus.nats.dlq.published`, `bus.nats.dlq.errors`
- **Alert thresholds (suggested)**:
  - Connection storms: `bus.reconnect.events` > 5/min or `bus.reconnect.delay` p95 > 5s
  - DLQ spike: `bus.nats.dlq.published` > 100/min sustained for 5 minutes
  - Pending lag: `bus.nats.pending_lag` > 5_000 for 3 consecutive scrapes
  - Hot keys: `bus.partition.hot_key` > 10/min (investigate tenant/topic skew)

## Incident Playbooks

### Connection Storm / Broker Disconnect
**Symptoms**: `/ready` returning 503, spikes in `bus.reconnect.events`, logs showing “failed to publish audit event” or “connection closed”.

**Checklist**:
1. Confirm broker availability (NATS monitoring, infra alerts). If cluster is unstable, escalate to DevOps (Slack `#infra-p1`).
2. Check credential validity. If JWT/creds expired, rotate secrets (`NATS_CREDS_PATH`) and call `refreshNatsBusSecurity()` (or redeploy).
3. Increase jitter/backoff temporarily via `NATS_RECONNECT_BASE_DELAY_MS`/`MAX_DELAY_MS` to ease reconnect pressure.
4. Verify TLS certs (`NATS_TLS_*`). Failed handshakes show as repeated disconnect events with errors in service logs.
5. Once broker stabilises, ensure readiness recovers (pending lag clears) before closing the incident.

### DLQ Spike / Poison Messages
**Symptoms**: `bus.nats.dlq.published` jumping, `bus.nats.dlq.poison` incrementing.

**Checklist**:
1. Inspect DLQ payloads via `node scripts/dlq-requeue.js --peek broker.dlq` or the Grafana DLQ table. Verify `retryable` flag.
2. If messages are retryable, likely a transient downstream outage. Confirm consumer health and coordinate resume.
3. For poison messages (validation/auth failures), review `payloadRef.code` / `payloadRef.reason` and notify the owning feature team.
4. Watch `bus.msg.too_large` — if high, re-review publishers for large blob use; route large binaries to object storage.
5. Once root cause is addressed, requeue selected DLQ entries with `scripts/dlq-requeue.js` or purge if obsolete.

### Consumer Lag / Backpressure
**Symptoms**: `bus.nats.pending_lag` above threshold, readiness failing, `bus.backpressure.events` incrementing.

**Checklist**:
1. Identify which topics are lagging (Grafana graph). Cross-reference with tenant throughput metrics.
2. Ensure consumers are running (`kubectl get pods`, service logs). Restart hung consumers as needed.
3. Scale consumer replicas or increase resources (CPU/memory) if throughput has permanently increased.
4. Review partition distribution (`bus.partition.hot_key`). Consider increasing `NATS_PARTITIONS` or adjusting key hashing.
5. If upstream producers flood the bus, coordinate rate reductions or enable stricter tenant quotas.

### Authentication / TLS Failures
**Symptoms**: Logs: “TLS is required”, “authorization violation”, metrics show connection oscillation.

**Checklist**:
1. Validate secrets in the secret store; ensure new `.creds` is deployed and path matches `NATS_CREDS_PATH`.
2. For TLS, confirm CA/cert/key files exist and matches broker CA. Renew certs via automation (refer to security runbook).
3. Redeploy services (or run `refreshNatsBusSecurity()` if supported) to load new credentials.
4. Monitor `bus.reconnect.events` to confirm stable reconnects.

## Escalation Matrix
- P0 (system outage, sustained DLQ growth): @on-call backend, DevOps on-call, escalate to platform lead within 15 minutes.
- P1 (degraded but still serving): backend on-call, notify feature owners for impacted topics.
- Security/TLS issues: involve security team if cert compromise suspected.

## Post-Incident Review Checklist
- Capture timeline of metrics & actions.
- Note config changes (backoff adjustments, quota overrides) and revert after stability.
- File follow-up tasks: e.g., adjust thresholds, automate rotation.
