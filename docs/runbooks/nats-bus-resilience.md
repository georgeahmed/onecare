# NATS Bus Resilience Playbook

## Purpose
- Document the retry, reconnect, and idempotency controls implemented in the Node.js orchestrator NATS adapter.
- Provide operators guidance for tuning reconnect behaviour and inspecting health/metrics during incidents.

## Defaults & Environment Flags
- `NATS_RECONNECT_BASE_DELAY_MS` (default `1500`): base delay for the first reconnect attempt.
- `NATS_RECONNECT_MAX_DELAY_MS` (default `30000`): upper bound for reconnect delay after exponential backoff.
- `NATS_RECONNECT_JITTER_RATIO` (default `0.2`): random jitter applied to each reconnect delay (0–1 range).
- `NATS_MAX_DELIVERIES` (default `5`): maximum redelivery attempts before routing a message to the DLQ.
- `NATS_RETRY_BASE_DELAY_MS` (default `500`): retry backoff baseline for message-level `nak` scheduling.
- `NATS_RETRY_MAX_DELAY_MS` (default `30000`): cap for message retry delays before DLQ handoff.
- `NATS_ACK_WAIT_MS` / `NATS_MAX_ACK_PENDING`: still respected for consumer ack deadlines and in-flight limits.
- `NATS_PARTITIONS` (default `1`): number of hash-based partitions per topic; express subjects as `<topic>.p<n>`.
- `NATS_MAX_MESSAGE_BYTES` (default `524288`): hard ceiling for payload size before rejecting publishes.
- `NATS_PENDING_LAG_THRESHOLD` (default `500`): pending message count that triggers backpressure and readiness failures.
- `BUS_READY_PENDING_LAG` (default `200`): orchestrator readiness cutoff for pending JetStream backlog.
- `NATS_TLS_ENABLED` / `NATS_TLS_REQUIRED` (default `true` in production): enforce TLS. Pair with `NATS_TLS_CA_PATH`, `NATS_TLS_CERT_PATH`, `NATS_TLS_KEY_PATH`, and optionally `NATS_TLS_REJECT_UNAUTHORIZED=0` for lab brokers.
- `NATS_CREDS_PATH`: path to operator-issued `.creds` file; overrides user/pass/token envs and supports hot reload via `refreshNatsBusSecurity()`.
- `NATS_DLQ_MESSAGE_LIMIT` (default `256`): maximum characters preserved in DLQ `errorMessage` to avoid leaking PHI.

## Connection Lifecycle
- Orchestrator uses exponential backoff with jitter for reconnects; attempts are tracked via the `bus_reconnect_scheduled_total` counter and `bus_reconnect_delay` histogram.
- Status events from the NATS client increment `bus_reconnect_events_total` (for `reconnect`) and `bus_disconnect_events_total` (for `disconnect`, `error`, `reconnecting`, `staleConnection`, `pingTimer`, `ldm`).
- `markNatsBusConnected` mirrors the live connection state into diagnostics exposed by `@onecare/bus`.
- `/ready` and `/readyz` now consult cached `getNatsBusHealth()` snapshots; backpressure or disconnections yield HTTP 503 with details in the payload.

## Security & Credential Rotation
- Production defaults force TLS; `@onecare/bus` refuses plaintext when `NODE_ENV=production` unless `NATS_TLS_REQUIRED=0`. Supply certificate material via `NATS_TLS_CA_PATH`, `NATS_TLS_CERT_PATH`, and `NATS_TLS_KEY_PATH` (PEM files); secrets are never logged.
- Prefer `.creds` bundles (`NATS_CREDS_PATH`) for NATS user JWTs/seeds. Call `refreshNatsBusSecurity(bus)` after rotating creds to tear down the connection and re-load certificates/credentials without restarting the process.
- Basic auth (`NATS_USER`/`NATS_PASS`) and tokens remain supported for lab setups but should be avoided in production.

## Message Handling & Idempotency
- Each published envelope carries an enforced `x-message-id` header matching the envelope `id`; this becomes the JetStream `msgID` to unlock server-side deduplication.
- On failure handlers, the bus schedules `nak` retries with jittered delays until `NATS_MAX_DELIVERIES` is reached. Telemetry is exposed via `retriesScheduled` in diagnostics.
- After reaching the delivery ceiling, the message is wrapped into `schemas/common/dlq-event.json` and re-published to the configured DLQ topic with correlation and message identifiers preserved.
- DLQ publishes and failures are tracked via the diagnostics (`dlqPublished`, `dlqPublishFailures`), and message backlog is surfaced as `pendingLag`.

## Operational Checklist
1. **Reconnect Storms**  
   - Inspect `bus_reconnect_delay` for large spikes; adjust `NATS_RECONNECT_BASE_DELAY_MS` / `MAX_DELAY_MS` if the cluster is slow to recover.  
   - Validate infrastructure health (DevOps runbooks) before widening backoff to avoid thundering herds.
2. **DLQ Growth**  
   - Check the DLQ payload references for `deliveries` vs. `maxDeliveries`. If max is hit consistently, verify downstream services honour `x-message-id` dedupe and escalate to feature owners.
3. **Lag Monitoring**  
   - `pendingLag` in diagnostics reports the last JetStream pending count. Alert if values remain high after successful reconnects; indicates consumers cannot keep up.
4. **Idempotency Failures**  
   - Ensure event envelopes provide stable `id` values. For legacy publishers, set `x-idempotency-key` to avoid duplicate message IDs.
5. **Partition Hot Spots**  
   - If a few partitions dominate traffic, inspect the partition keys in headers (`x-partition-key`) and consider widening `NATS_PARTITIONS` or re-balancing key selection.
6. **Backpressure Handling**  
   - When `backpressure` toggles true in diagnostics, orchestrator will log `bus readiness degraded`. Investigate pending counts and reduce producers until metrics stabilize.
7. **DLQ Poison Messages**  
   - Non-retryable failures (e.g., schema/validation errors) set `payloadRef.retryable=false` and increment `bus_nats_dlq_poison_total`. Review `x-failure-category`/`x-error-code` headers to triage upstream fixes.

## DLQ Requeue Utility
- `node scripts/dlq-requeue.js <topic> <payload.json>` republishes a sanitized payload to the original topic using the current bus configuration. Supply the JSON payload you want to re-drive; the script reuses partition hashing and headers automatically.

## Verification
- `npm run test -- packages/bus` exercises the guard and adapter parity unit tests (see `packages/bus/test/natsBus.test.ts`).
- For manual smoke tests, run `npm run smoke:nats` with a live broker. Observe metrics via the orchestrator `/ready` endpoint and log output for connection status transitions.
