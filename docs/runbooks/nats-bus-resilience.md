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

## Connection Lifecycle
- Orchestrator uses exponential backoff with jitter for reconnects; attempts are tracked via the `bus.reconnect.scheduled` counter and `bus.reconnect.delay` histogram.
- Status events from the NATS client increment `bus.reconnect.events` (for `reconnect`) and `bus.disconnect.events` (for `disconnect`, `error`, `reconnecting`, `staleConnection`, `pingTimer`, `ldm`).
- `markNatsBusConnected` mirrors the live connection state into diagnostics exposed by `@onecare/bus`.

## Message Handling & Idempotency
- Each published envelope carries an enforced `x-message-id` header matching the envelope `id`; this becomes the JetStream `msgID` to unlock server-side deduplication.
- On failure handlers, the bus schedules `nak` retries with jittered delays until `NATS_MAX_DELIVERIES` is reached. Telemetry is exposed via `retriesScheduled` in diagnostics.
- After reaching the delivery ceiling, the message is wrapped into `schemas/common/dlq-event.json` and re-published to the configured DLQ topic with correlation and message identifiers preserved.
- DLQ publishes and failures are tracked via the diagnostics (`dlqPublished`, `dlqPublishFailures`), and message backlog is surfaced as `pendingLag`.

## Operational Checklist
1. **Reconnect Storms**  
   - Inspect `bus.reconnect.delay` for large spikes; adjust `NATS_RECONNECT_BASE_DELAY_MS` / `MAX_DELAY_MS` if the cluster is slow to recover.  
   - Validate infrastructure health (DevOps runbooks) before widening backoff to avoid thundering herds.
2. **DLQ Growth**  
   - Check the DLQ payload references for `deliveries` vs. `maxDeliveries`. If max is hit consistently, verify downstream services honour `x-message-id` dedupe and escalate to feature owners.
3. **Lag Monitoring**  
   - `pendingLag` in diagnostics reports the last JetStream pending count. Alert if values remain high after successful reconnects; indicates consumers cannot keep up.
4. **Idempotency Failures**  
   - Ensure event envelopes provide stable `id` values. For legacy publishers, set `x-idempotency-key` to avoid duplicate message IDs.

## Verification
- `npm run test -- packages/bus` exercises the guard and adapter parity unit tests (see `packages/bus/test/natsBus.test.ts`).
- For manual smoke tests, run `npm run smoke:nats` with a live broker. Observe metrics via the orchestrator `/ready` endpoint and log output for connection status transitions.
