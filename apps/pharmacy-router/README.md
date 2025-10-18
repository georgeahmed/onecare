Pharmacy Router Service
========================

The pharmacy router orchestrates Pharmacy First referrals. It ingests
`pharmacy.referral` events, validates eligibility, dispatches referrals to the CPCS API, persists
outcomes to FHIR, and emits patient-facing status notifications.

At a glance
-----------
- **State machine**: `Classified → Eligible → Referred → OutcomeRecorded`
  (`apps/pharmacy-router/src/application/pharmacy.state.ts`).
- **Adapters**:
  - `CpcsHttpClient` for CPCS integration with retries, circuit breakers, and slotless fallback.
  - `PharmacyRouterConsumer` for event ingestion, bounded concurrency, retries, and DLQ routing.
  - `PatientNotificationAdapter` for consent-aware, idempotent patient notifications.
- **Contracts first**: schemas live in `schemas/pharmacy/*.json`; run `npm run codegen` to regenerate
  TypeScript models under `packages/events/src/contracts/*`.

Events & contracts
------------------

| Direction | Topic | Schema | Notes |
|-----------|-------|--------|-------|
| Ingress | `pharmacy.referral` | `schemas/pharmacy/pharmacy-referral.json` | Mandatory guardrail for eligibility inputs and slot metadata. |
| Egress | `pharmacy.outcome` | `schemas/pharmacy/pharmacy-outcome.json` | Published after idempotent FHIR write-back. |
| Egress | `pharmacy.notification` | `schemas/pharmacy/pharmacy-notification.json` | PHI-free patient notifications (length capped, consent checked). |
| DLQ | `broker.dlq` | `schemas/common/dlq-event.json` | Minimal payload + `payloadRef` for replay and investigation. |

Example payloads sit in `packages/domain/test/fixtures/events/pharmacy.*.json`. Contract tests covering
each event variant live in `packages/domain/test/contracts/core-events.test.ts`.

Running locally
---------------

```
# Install dependencies across the monorepo.
npm install

# Regenerate TypeScript (and optional Python) contracts after schema edits.
npm run codegen

# Execute the service test suite (state machine, adapters, consumer, notifier).
npm run test -- apps/pharmacy-router/test
```

Patient notifications
---------------------

`PatientNotificationAdapter` publishes `pharmacy.notification` envelopes with the following features:

- pluggable consent evaluator, returning `false` to skip publication quietly;
- sanitised, length-capped summaries (max 280 chars) and PHI avoidance by design;
- exponential backoff with jitter and bounded retries before surfacing a failure to the state machine;
- idempotency via `x-idempotency-key` headers aligned with the router’s idempotency store entries;
- structured observability (`pharmacy.notification.sent_total`, `.skipped_total`, `.retry_total`,
  `.failed_total`, and `pharmacy.notification.retry_delay_ms`).

Sample wiring:

```ts
import { MemoryBus } from '@onecare/bus';
import { PatientNotificationAdapter, handlePharmacyReferral } from '@onecare/app-pharmacy-router';

const bus = new MemoryBus(); // swap with NatsBus in production
const notifier = new PatientNotificationAdapter({
  bus,
  consentEvaluator: async ({ organisationId }) => organisationId !== 'pharmacy/blocked',
});

const result = await handlePharmacyReferral(referral, {
  cpcsClient,
  config,
  fhirRepository,
  notifier,
  idempotencyStore,
});
```

Observability & metrics
-----------------------

- **CPCS adapter**: `integration.call.*` counters/histograms capture latency, retries, timeouts, and
  circuit-breaker trips; log entries include correlation IDs and hashed organisation identifiers.
- **Router consumer**: `pharmacy.router.*` counters measure ingress, success/failure, retries, and DLQ
  volume, while `pharmacy.router.process_duration_ms` / `pharmacy.router.ingest_lag_ms` histograms track
  latency budgets.
- **Patient notifications**: `pharmacy.notification.*` counters and retry-delay histogram surface
  consent skips, retries, and failures.
- Structured logs never include PHI; identifiers are hashed (see `fingerprint()` helper in the state).

Configuration highlights
------------------------

- Eligibility rules resolve from `@onecare/config` (practice defaults + condition overrides).
- CPCS configuration enforces HTTPS endpoints, disallows private/loopback hosts, and supports retry &
  circuit policies (`applyCpcsConfig` in `@onecare/config`).
- Idempotency relies on `@onecare/ports` `IdempotencyStore`; supply a Redis-backed implementation and
  pass it via `handlePharmacyReferral` dependencies.
- Provide a `MessageBus` implementation (e.g., `NatsBus`) when deploying; tests default to `MemoryBus`.

Integration updates (October 2025)
----------------------------------

- `CpcsHttpClient` now rejects non-HTTPS or private endpoints, auto-injects `Accept: application/json`,
  and exposes `refreshCredentials({ headers, apiKey, correlationHeader })` so CPCS secrets can rotate
  without recreating the client.
- Deterministic performance harnesses (`test/cpcs.perf.test.ts`) assert the referral path stays within
  a 20 ms per-call budget and continue to emit `integration.latency_ms` histograms for regressions.
- Sandbox fixtures for CPCS/ICS integrations live under `apps/ics-hub/src/dev/fixtures`; tests and
  local workflows can combine them with the sandbox harness to replay common flows offline.

Related ADR
-----------

- `docs/adr/2025-10-15-pharmacy-router-strategy.md` documents the overall design decisions, ingress/egress
  contract guarantees, and notification strategy.
