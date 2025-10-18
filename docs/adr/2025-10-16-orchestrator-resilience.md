# ADR: Orchestrator Resilience Guardrails

- **Status**: Accepted
- **Date**: 2025-10-16

## Context

Ingress traffic to the orchestrator spiked during load tests, revealing that a single hung request could starve the process, event publishes lacked retry/DLQ coverage, and audit writes blocked on the downstream ledger. Privacy checks also highlighted that raw patient IDs were present in logs/audits. We needed deterministic backpressure, rate limiting, safe shutdown semantics, and defensible logging before enabling wider traffic.

## Decision

- Enforce bounded concurrency with a global limit plus per-route budgets (`ORCHESTRATOR_MAX_CONCURRENCY_*`). Busy routes return HTTP 503 (`busy`) and emit `backpressure.reject` metrics.
- Apply token-bucket rate limiting per actor (`ORCHESTRATOR_RATE_LIMIT_*`); exhausted callers receive HTTP 429 with `Retry-After` and we log `rate.limit.block`.
- Wrap bus publishes with guarded retries (`ORCHESTRATOR_BUS_PUBLISH_*`) and route exhausted attempts to `broker.dlq` with hashed payload references.
- Buffer audit writes in-process with bounded queue + retry to avoid blocking ingress when the ledger stalls.
- Hash patient identifiers before logging/auditing (`patientRef`) to meet privacy guidance while preserving downstream payloads.
- Add graceful shutdown handling (SIGTERM/SIGINT) that refuses new work while draining in-flight requests so k8s probes reflect the draining state.
- Extend automated tests to cover concurrency saturation, rate limiting, DLQ routing, and shutdown behaviour.

## Consequences

- Additional env vars must be tuned per environment; defaults keep dev experience intact (memory bus, small limits).
- DLQ payloads now carry hashed references; replay tooling must resolve references via audit trail rather than raw IDs.
- New metrics/alerts should be wired into dashboards (`backpressure.reject`, `rate.limit.block`, `audit.write.retry`).
- Tests use helper resets (`resetShutdownStateForTest`) to clear limiter state between scenarios.
