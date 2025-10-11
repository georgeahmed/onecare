ADR: Resilience (Timeouts, Retries, CB, Fallback)

Status: Proposed
Date: 2025-10-11

Context
- External dependencies (safety gate, audit) can fail transiently. We require bounded latency and graceful degradation.

Decision
- Wrap outbound calls with `callWithGuard`: timeout (2s), retries (2) with exp backoff + jitter, circuit breaker, and trace propagation.
- On CB open for safety gate, use documented rules fallback within budget.

Consequences
- Predictable tail latency; controlled failure modes; observable metrics/spans.

