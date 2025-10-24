Stable Backend Gate Checklist

Purpose
- A concise, actionable checklist to declare the backend “stable.” Intended for PR gates and release readiness.

Contracts & Validation
- Schemas updated with coherent `$id` and `additionalProperties: false`.
- `npm run codegen:check` clean; generated TS/Py present if schemas changed (run `npm run --workspaces=false codegen`).
- All ingress paths validate against compiled JSON Schemas; return structured envelopes on 4xx.

Reliability & Idempotency
- Outbound calls implement timeouts (2s default), retries (max 2, jitter), circuit breakers, and fallbacks.
- DLQ and bounded retry policies defined for all event publishes/consumes; idempotency keys on publish and dedupe on consume.
- Ingress idempotency guards prevent duplicate side effects; conflict paths return 409 envelopes.

Security & Privacy
- SSRF protections and header/input sanitation at all network boundaries.
- No PHI/PII or secrets in logs/events; redaction helpers wired.
- Service-to-service auth configured (where applicable); secrets not logged and rotation-ready.

Observability & SLOs
- CorrelationId propagates across HTTP→bus→ports; structured logs present.
- Key metrics (latency histograms, error/retry counters, backpressure) emitted; spans instrumented.
- SLOs defined for key endpoints/flows with baselines recorded (p50/p95; error rates).

Backpressure & Performance
- Concurrency limits and time budgets enforced; graceful degrade paths defined (429/503).
- Rate limiting on front doors; publish quotas per tenant where applicable.
- Microbench tests and optional local load harnesses in place; no excessive logging in hot paths.

Health, Shutdown, and Runbooks
- `/healthz` and `/readyz` probes in all services; readiness reflects critical deps.
- Graceful shutdown drains inflight and closes adapters within budget.
- Runbooks for incidents (bus DLQ spikes, connection storms, dependency outages) are documented with alert thresholds.

How to Use
- Local gate: `npm run codegen:check && npm run typecheck && npm test`.
- Manual spot-check: run fault-injection tests, review DLQ flows, verify logs redact sensitive data.
