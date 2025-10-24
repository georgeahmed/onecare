# 2025-10-13 — CPCS / ICS integration guardrails

## Status
Accepted

## Context
- CPCS and ICS adapters previously allowed arbitrary HTTPS endpoints with no runtime credential refresh or
  deterministic playback fixtures.
- Performance budgets and Accept header requirements were documented but not enforced by code or tests.
- Billing contract schemas were missing, blocking downstream validation and DLQ parity with other adapters.

## Decision
1. Harden outbound integrations:
   - `CpcsHttpClient` now enforces HTTPS + public endpoints via `ensureSafeCpcsBaseUrl`, injects
     `Accept: application/json`, and exposes `refreshCredentials()` for runtime header/token rotation.
   - `IcsHttpClient` mirrors the same SSRF guard, normalises endpoints, sets Accept defaults, and adds
     `refreshRouteCredentials()` to rotate headers, API keys, correlation headers, and TLS bundles per route.
2. Establish repeatable baselines:
   - Added perf harnesses (`apps/pharmacy-router/test/cpcs.perf.test.ts`,
     `apps/ics-hub/test/ics.perf.test.ts`) asserting ≤20 ms average latency (≤15 ms for ICS acks) and
     verifying histograms remain populated.
   - Introduced deterministic fixtures (`apps/ics-hub/src/dev/fixtures/*.json`) with the
     `createSandboxHarness()` helper for offline playback and CI scenarios.
3. Define billing contracts + reliability:
   - New JSON schemas (`schemas/billing/claim.json`, `schemas/billing/response.json`) with generated
     TypeScript contracts.
   - Validators (`apps/billing/src/adapters/contracts.ts`) invoked by `BillingHttpClient` before outbound
     calls and on responses.
   - Billing bus adapter publishes claim/response envelopes with bounded retries and DLQ fallback.

## Consequences
- Credential rotation can be triggered by updating headers/API keys without tearing down clients.
- Invalid billing payloads fail fast with structured contract errors and never bypass DLQ safeguards.
- Sandbox fixtures unblock deterministic testing for CPCS/ICS flows and act as reference payloads for
  future contract tests.
- Accept defaults remove duplication across services and codify content negotiation requirements.
