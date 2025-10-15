# Completed Tasks — Backend Engineer 05

- [x] **BE-05.1 — Eligibility rules config + evaluator**  
  Evidence: `apps/pharmacy-router/src/application/eligibility.ts:24` implements the rule-driven `isEligible` checks (age, sex, severity, exclusions), and `apps/pharmacy-router/test/eligibility.test.ts:37` exercises the happy-path and guardrail cases.

- [x] **BE-05.2 — CPCS adapter interface**  
  Evidence: `apps/pharmacy-router/src/adapters/cpcs.client.ts:214` defines the hardened HTTP client with retries, circuit breaker, correlation headers, and fallback logic, while `apps/pharmacy-router/test/cpcs.client.test.ts:36` verifies environment/config wiring, timeouts, error mapping, circuit opening, and slotless fallback behaviour.

- [x] **BE-05.3 — Referral path + outcome write-back**  
  Evidence: `apps/pharmacy-router/src/application/pharmacy.state.ts:155` orchestrates the referral call and patient notification, and `apps/pharmacy-router/src/application/pharmacy.state.ts:219` persists the outcome bundle to FHIR with idempotent upsert semantics; covered by `apps/pharmacy-router/test/pharmacy.state.test.ts:228`.

- [x] **BE-05.5 — Idempotency & dedupe**  
  Evidence: `apps/pharmacy-router/src/application/pharmacy.state.ts:219` and `apps/pharmacy-router/src/application/pharmacy.state.ts:374` wrap outcome persistence and patient notifications with `executeWithIdempotency`, and `apps/pharmacy-router/test/pharmacy.state.test.ts:285` confirms duplicate notifications/outcomes are suppressed.

- [x] **BE-05.7 — Observability**  
  Evidence: `apps/pharmacy-router/src/adapters/cpcs.client.ts:123` registers latency/error/circuit metrics and propagates correlation IDs into logs/spans, and `apps/pharmacy-router/src/application/pharmacy.state.ts:93` uses hashed fingerprints plus structured logging across the state transitions.

- [x] **BE-05.13 — GP fallback path**  
  Evidence: `apps/pharmacy-router/src/application/pharmacy.state.ts:141` raises escalation Tasks on ineligibility, `apps/pharmacy-router/src/application/pharmacy.state.ts:240` re-uses the same path when referrals fail, and `apps/pharmacy-router/src/application/pharmacy.state.ts:477` builds the Task payload.

- [x] **BE-05.14 — Fault injection tests**  
  Evidence: `apps/pharmacy-router/test/cpcs.client.test.ts:165` injects timeout, 5xx, and circuit-breaker scenarios, and `apps/pharmacy-router/test/pharmacy.state.test.ts:262` covers referral failure handling plus idempotency duplicates.


Status: planned
Progress: 0%