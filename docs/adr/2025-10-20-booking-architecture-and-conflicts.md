# 2025-10-20 — Booking Architecture and Conflict Semantics

- Status: Accepted
- Deciders: Booking, Integrations, Platform
- Date: 2025-10-20

## Context

The Booking service brokers patient appointments through GP Connect while keeping business logic in deterministic states and delegating side effects to adapters. Earlier ADRs covered the GP Connect client guardrails, but we lacked documentation tying the state machine, conflict handling, and event contracts together. Repeated work on sandboxing and E2E coverage also highlighted the need to codify how we handle retryable 409 conflicts, publish events idempotently, and surface updated slot availability to callers.

## Decision

1. **State-Oriented Architecture** — Booking uses a five-state machine (`Search → Selected → Booked → WrittenBack → Confirmed`). Application code normalises search parameters, applies enhanced-access policies, and orchestrates persistence/notifications. Adapters (`gpconnect.client`, FHIR repository, message bus, audit publisher, queue notifier) remain side-effect boundaries.
2. **GP Connect Integration** — All upstream calls flow through `GpConnectHttpClient`, which enforces HTTPS-only endpoints, OAuth/mTLS rotation, and guarded requests with bounded retries (`callWithGuard`). Search requests pin `_count=20` and propagate organisation/service filters; create requests retry once on conflict with exponential backoff.
3. **Conflict Handling** — When GP Connect returns 409, the state machine maps it to `booking.create.conflict`, increments metrics, and triggers a best-effort slot refresh (`searchSlots` with original parameters). Refreshed slots replace the prior context so callers see updated availability instead of stale data.
4. **Idempotent Booking** — Appointment creation, persistence, queue notification, audit emission, and event publishing execute inside `executeWithIdempotency`. The key derives from hashed patient ID + slot ID + origin correlation, ensuring duplicates short-circuit while logging duplicate attempts.
5. **Event Contracts** — Successful bookings publish `Topics.booking.appointmentCreated` envelopes validated against `schemas/booking/appointment-created.json`; duplicates route to `Topics.booking.appointmentCreatedDlq`. Publishes use a guarded bus wrapper and retry twice before DLQ, capturing attempts and correlation IDs for replay.
6. **Sandbox Playback** — Deterministic fixtures (`fixtures/gpconnect/*.json`) back a playback harness used in contract and state tests, guaranteeing offline reproducibility for search pagination, success, and conflict retry scenarios.

## Consequences

- Clear separation of concerns has reduced accidental side effects in adapters and made state tests deterministic.
- Operators can rely on consistent conflict semantics: 409s are surfaced with safe messaging, metrics, DLQ/audit entries, and refreshed slot inventories.
- Idempotency requirements mandate an `IdempotencyStore` implementation per environment; without it, duplicate HTTP calls may double-book.
- The playback harness now serves as the reference for API consumers and contract tests; fixture drift must be managed alongside schema updates.
- Event contracts remain stable; future schema changes require updating both `schemas/booking/*` and the playback fixtures to keep tests aligned.
