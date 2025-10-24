# ICS Hub SLO Baselines

## Latency Targets
- **Routing**: `ics_routing_latency_ms` histogram captures end-to-end routing decisions. Baseline perf harness (Vitest `apps/ics-hub/test/ics.perf.test.ts`) demonstrates p50 ≤ 20 ms and p95 ≤ 35 ms for in-memory configs.
- **Ack publishing**: `ics_ack_latency_ms` histogram covers time from ingress to ack publish. Baseline budgets are p50 ≤ 15 ms and p95 ≤ 30 ms under single worker load.

## Metrics & Counters
- `ics_routing_decisions_total` — decision outcomes (`allowed`, `blocked`, `rate_limited`, `invalid`).
- `ics_routing_latency_ms` — recorded in `ValidatedState` once routing is deemed actionable.
- `ics_ack_published_total`, `ics_ack_failed_total`, `ics_ack_duplicate_total`, `ics_ack_latency_ms` — ack success/failure/duplicate tracking.
- `ics_backpressure_overload_total`, `ics_backpressure_wait_ms` — concurrency/backpressure health.
- `ics.audit.spool_*` — enqueue/publish/drop counters for the audit spool.

## Validation Commands
- `npx vitest run apps/ics-hub/test` — unit, contract, resilience, and perf baselines.
- `npx vitest run apps/ics-hub/test/ics.perf.test.ts` — microbench harness for routing/ack latency budgets.
- Alert rules: see `docs/observability/alerts/ICS_LATENCY.yaml` (Prometheus) for p95 thresholds tied to the metrics above.

## Operational Notes
- Readiness `/readyz` flips to `503` when the bus disconnects or shutdown begins, with caching governed by `READINESS_CACHE_MS` (default 1s).
- Backpressure controls (processing limiter + token bucket) respond with 429 envelopes and include `Retry-After` seconds.
- Audit events are published via a bounded, retrying spool; overflow conditions are logged and metered.
