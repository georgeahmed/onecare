Title: Pharmacy Router Strategy
Date: 2025-10-15
Status: Accepted

Context
- Pharmacy First requires deterministic routing from eligibility through CPCS dispatch and FHIR outcome write-back.
- Events must remain contract-first; downstream consumers (analytics, notifications, DLQ tooling) rely on typed envelopes.
- Patient messaging must honour consent, avoid PHI, and tolerate transient delivery failures.

Decision
- Validate ingress with `pharmacy.referral` schema before executing the state machine. All generated contexts carry hashed identifiers and correlation IDs.
- Persist outcomes via idempotent FHIR bundle upserts and publish `pharmacy.outcome` events for downstream reconciliation.
- Introduce a dedicated `pharmacy.notification` event emitted by a consent-aware notifier adapter with bounded retries and idempotency headers.
- Run all router ingestion through `PharmacyRouterConsumer`, enforcing topic allowlists, correlation propagation, DLQ routing, and concurrency throttling.

Consequences
- Schema changes must run through `npm run --workspaces=false codegen` and extend contract tests (`packages/domain/test/contracts/core-events.test.ts`) for referral/outcome/notification payloads.
- Operators gain metrics covering CPCS calls, referral processing, and patient notifications for SLO monitoring.
- Consent failures skip notifications without surfacing as errors; transient publish failures retry with jittered backoff before surfacing to the state machine.
- Bus implementations must respect message IDs / idempotency headers; production deployments should wire `NatsBus`, while tests remain on `MemoryBus`.

Implementation Notes
- See `apps/pharmacy-router/src/adapters/consumer.ts` for bounded concurrency + DLQ handling.
- `apps/pharmacy-router/src/adapters/patient-notifier.ts` implements the notifier contract and retry policy.
- New schemas: `schemas/pharmacy/pharmacy-outcome.json` and `schemas/pharmacy/pharmacy-notification.json`.
