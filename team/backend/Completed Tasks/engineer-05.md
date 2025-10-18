# Completed Tasks — Backend Engineer 05

- [x] **BE-05.1 — Eligibility rules config + evaluator**  \
  Evidence: `apps/pharmacy-router/src/application/eligibility.ts:24` implements the rule-driven evaluator and `apps/pharmacy-router/test/eligibility.test.ts:37` covers the eligibility/denial cases.

- [x] **BE-05.2 — CPCS adapter interface**  \
  Evidence: `apps/pharmacy-router/src/adapters/cpcs.client.ts:214` provides the hardened client (timeouts, retries, circuit breaker, correlation headers) and `apps/pharmacy-router/test/cpcs.client.test.ts:36` exercises the behaviour.

- [x] **BE-05.3 — Referral path + outcome write-back**  \
  Evidence: `apps/pharmacy-router/src/application/pharmacy.state.ts:155` orchestrates CPCS referrals/outcome persistence and `apps/pharmacy-router/test/pharmacy.state.test.ts:228` validates the flow.

- [x] **BE-05.4 — Contract validators & codegen**  \
  Evidence: `schemas/pharmacy/pharmacy-outcome.json:1` defines the outcome schema and `packages/domain/test/contracts/core-events.test.ts:294` extends contract tests for pharmacy events.

- [x] **BE-05.5 — Idempotency & dedupe**  \
  Evidence: `apps/pharmacy-router/src/application/pharmacy.state.ts:219` wraps outcome persistence/notifications with `executeWithIdempotency` and `apps/pharmacy-router/test/pharmacy.state.test.ts:285` verifies duplicate suppression.

- [x] **BE-05.6 — DLQ and retry policy**  \
  Evidence: `apps/pharmacy-router/src/adapters/consumer.ts:25` adds guarded ingestion with bounded retries/DLQ publishing, covered by `apps/pharmacy-router/test/consumer.test.ts:58`.

- [x] **BE-05.7 — Observability**  \
  Evidence: `apps/pharmacy-router/src/adapters/cpcs.client.ts:123` emits structured metrics/logs for CPCS calls and `apps/pharmacy-router/src/application/pharmacy.state.ts:93` logs hashed eligibility decisions.

- [x] **BE-05.8 — Security & privacy guardrails**  \
  Evidence: `apps/pharmacy-router/src/adapters/cpcs.client.ts:683` enforces HTTPS/host allowlist for CPCS endpoints and `apps/pharmacy-router/test/cpcs.client.test.ts:129` asserts rejection of loopback/private URLs.

- [x] **BE-05.9 — Performance baselines**  \
  Evidence: `apps/pharmacy-router/src/adapters/consumer.ts:25` records ingest lag and processing latency histograms for the referral pipeline.

- [x] **BE-05.10 — Health/readiness & graceful shutdown**  \
  Evidence: `apps/pharmacy-router/src/adapters/consumer.ts:101` implements controlled start/stop with idle draining via semaphore for clean shutdown diagnostics.

- [x] **BE-05.11 — Documentation & ADRs**  \
  Evidence: `apps/pharmacy-router/README.md:1` documents architecture/operations and `docs/adr/2025-10-15-pharmacy-router-strategy.md:1` captures the ingress/egress + notification decisions.

- [x] **BE-05.12 — Patient notification adapter**  \
  Evidence: `apps/pharmacy-router/src/adapters/patient-notifier.ts:1` implements consent-aware notifications with retries/idempotency and `apps/pharmacy-router/test/patient-notifier.test.ts:1` exercises happy-path, consent skip, and retry exhaustion flows.

- [x] **BE-05.13 — GP fallback path**  \
  Evidence: `apps/pharmacy-router/src/application/pharmacy.state.ts:141` raises escalation Tasks on ineligibility/referral failure.

- [x] **BE-05.14 — Fault injection tests**  \
  Evidence: `apps/pharmacy-router/test/cpcs.client.test.ts:168` injects timeouts/5xx/circuit-trip scenarios to confirm resilience.

- [x] **BE-05.15 — Rate limits & backpressure**  \
  Evidence: `apps/pharmacy-router/src/adapters/consumer.ts:70` applies a concurrency semaphore to throttle referral processing and expose queue diagnostics.


Status: planned
Progress: 0%