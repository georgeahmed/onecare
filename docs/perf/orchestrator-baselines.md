# Orchestrator Performance Baselines

_Last updated: 2025-10-16_

## Methodology

- Launch orchestrator locally with BUS_IMPL=memory and Python safety gate stub (`npm run dev:all`).
- Warm the process with 50 requests at concurrency 5.
- Measure `/safety-check` via `make perf-orchestrator` (wraps `autocannon`) for 30s at concurrency 20.
- Capture latency (p50/p95/p99), throughput (req/s), and error counts. Record CPU/memory using `pidusage` snapshot and note max RSS.
- Repeat with concurrency 40 to validate backpressure (expect 503 `busy` once the limit is reached).

## Current Baseline (MacBook Pro M3 / Node 20.11 / local memory bus)

| Scenario | Concurrency | p50 | p95 | p99 | req/s | Notes |
|----------|-------------|-----|-----|-----|-------|-------|
| Warm run | 5 | 14 ms | 22 ms | 32 ms | 320 | No errors |
| Load run | 20 | 21 ms | 41 ms | 58 ms | 1,120 | CPU ~55 %, RSS ~210 MB |
| Overload check | 40 | 24 ms | 49 ms | 72 ms | 1,230 | Backpressure triggered at concurrency cap (HTTP 503 `busy`) |

## Guardrail Checks

- Rate limiting: set `ORCHESTRATOR_RATE_LIMIT_SAFETY_PER_MINUTE=120` and fire 200 requests/min with a single actor; observe 429 `too_many_requests` and `rate.limit.block` logs.
- DLQ routing: set `ORCHESTRATOR_BUS_PUBLISH_MAX_RETRIES=0` and force the bus to throw; DLQ entries land on `broker.dlq` with hashed patient references.
- Graceful shutdown: send SIGTERM while load test is running; `/ready` flips to `not_ready` with `draining: true` and new ingress receives 503 `busy` while in-flight requests complete.

Record deviations in this doc when the baseline shifts (e.g., new state transitions, different safety-gate SLAs) and update release readiness accordingly.
