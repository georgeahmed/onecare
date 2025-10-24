# 2025-10-20 — ICS Routing, Ack Semantics, and Reprocessing

- Status: Accepted
- Deciders: ICS Hub, Automation, Platform
- Date: 2025-10-20

## Context

ICS Hub mediates referrals between commissioning systems and downstream providers. Earlier work established SSRF guardrails and sandbox fixtures, but we lacked a consolidated decision record covering:

- How organisation policies drive routing, rate limiting, and endpoint credentials.
- The contract for acknowledgements (acks) including idempotency, retries, and metrics.
- What happens when backpressure or downstream outages occur, and how DLQ/replay flows operate.

As automation and audit features gained complexity, the team needed shared guidance for operators and integrators.

## Decision

1. **Policy-Driven Routing** — `InboundState` loads `IcsOrganisationPolicy` entries from `@onecare/config`. Policies normalise organisation IDs, define destination endpoints, auth headers, and automation feature flags. A token-bucket limiter enforces per-org rate caps (`ics_routing_rate_limited_total`), emitting HTTP 429 with configurable `Retry-After` when exhausted. If the policy cache is stale we fall back to a default `fallback` policy while warning operators.
2. **Secure Endpoint Enforcement** — Routes must target HTTPS, non-private hosts and reject embedded credentials. `IcsHttpClient` maintains allowlists, rotates credentials (`refreshRouteCredentials()`), and applies bounded retries with circuit breakers.
3. **Acknowledgement Workflow** — Successful referrals yield acks published to `Topics.ics.referralAck`. `publishReferralAck` wraps bus publishes with idempotency: keys follow `ics:ack:{orgId}:{referralId}:{envelopeId}` and reuse the shared `IdempotencyStore`. Duplicate acks log `ics_ack_duplicate_total`. Failures retry with exponential backoff; exhausted attempts route to DLQ with summarised payloads and correlation IDs for replay.
4. **Backpressure & Processing Limits** — `ProcessingLimiter` caps concurrent referrals (`ICS_PROCESSING_MAX_CONCURRENCY`) and queue depth (`ICS_PROCESSING_QUEUE_LIMIT`). When limits trip we emit `ics_backpressure_*`, set `Retry-After`, and short-circuit before invoking downstreams, preserving fairness across organisations.
5. **Audit & DLQ Strategy** — Side-effect publishes (acks, automation tasks, audit logs) go through `publishWithGuard`. When publish attempts fail, we log at warn/error, increment counters, and send envelopes to `Topics.broker.deadLetter` with minimal PHI via `summariseForDlq`. `AuditSpool` buffers audit events with bounded retries before DLQ to avoid losing traceability.
6. **Replay Playbook** — Operators replay DLQ events using `src/dev/replay.ts`, which rebuilds state context, honours idempotency keys, and reuses the same guardrails. Metrics and logs flag replay actions to differentiate from live traffic.

## Consequences

- Routing changes now flow through config updates; schema drift or missing policies surface quickly with fallback warnings.
- Ack semantics are predictable: partners see at-most-once guarantees, measurable latency, and correlation IDs for reconciliation.
- During downstream outages the service degrades gracefully by back-pressuring and queuing audit logs, avoiding cascading failures.
- DLQ payloads remain lightweight and PHI-safe but sufficient for replay tooling; operators must monitor DLQ volume as part of readiness.
- Integration tests and playback harnesses mirror the policy/ack contract, so fixture updates are required when policy schemas evolve.
