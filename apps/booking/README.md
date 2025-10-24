Booking Service
===============

Purpose
-------
- Federated booking over GP Connect with deterministic write-back to FHIR and downstream event fan-out.

Runtime Architecture
--------------------
- HTTP adapter validates ingress payloads against `schemas/booking/booking-search-request.json` and `schemas/booking/booking-create-request.json`.
- State machine (`Search → Selected → Booked → WrittenBack → Confirmed`) orchestrates search, selection, appointment creation, persistence, queue notifications, and audit publishing.
- GP Connect integration lives in `src/adapters/gpconnect.client.ts`; it enforces HTTPS-only endpoints, OAuth/mTLS rotation, request guardrails via `callWithGuard`, and deterministic retries for conflicts.
- Outbound side effects (FHIR repository, queue notifier, audit publisher, event bus) are injected via `BookingContext`; business decisions remain in `src/application`.
- Idempotency is enforced through `executeWithIdempotency` and an `IdempotencyStore` (default TTL 10 minutes) so duplicate HTTP requests or retries short-circuit without rebooking or double-publishing.

HTTP Interfaces
---------------
- `POST /booking/search`  
  - Validates against `BookingSearchRequest` (`schemas/booking/booking-search-request.json`).  
  - Requires `x-correlation-id`; echoes it in responses and telemetry.  
  - Calls GP Connect `/Slot` with `_count=20`, propagating organisation/service type filters.  
  - Response envelope conforms to `schemas/booking/booking-search-response.json`.
- `POST /booking/appointments`  
  - Validates against `schemas/booking/booking-create-request.json`.  
  - Produces GP Connect `/Appointment` POST; on success persists Appointment/Task updates (when configured) and publishes booking events.  
  - Supplies `x-idempotency-key` header downstream via bus metadata; duplicates resolve using the injected store.  
  - Returns confirmation payload with sanitized identifiers.
- `POST /booking/assisted`  
  - Validates against `schemas/booking/assisted-outcome.json`.  
  - Records staff-assisted outcomes (booked/no-time/pharmacy-referral), writes the supporting Appointment (local record), updates/notes the originating `Task`, and emits `Topics.booking.assistedCompleted`.  
  - Available regardless of the GP Connect feature flag; use when staff confirm bookings inside clinical systems.
- `GET /healthz` and `GET /readyz`  
  - Liveness/readiness checks; readiness caches GP Connect status for `BOOKING_READINESS_CACHE_MS`.

Configuration
-------------
- Core GP Connect
  - `GP_CONNECT_URL` (required) — HTTPS endpoint for the proxy (public hostname only).
  - `GP_CONNECT_API_KEY` (required) — sent as `Ssp-Api-Key`.
  - `GP_CONNECT_TIMEOUT_MS` (default `5000`) — guard timeout for search/create operations.
  - `GP_CONNECT_AUTH_HEADER_NAME` / `GP_CONNECT_AUTH_HEADER_VALUE` — optional extra auth pair.
  - `GP_CONNECT_PRACTICE_ID` — practice identifier tagged on metrics/logs.
- OAuth & mTLS (optional)
  - `GP_CONNECT_TOKEN_URL`, `GP_CONNECT_CLIENT_ID`, `GP_CONNECT_CLIENT_SECRET`, `GP_CONNECT_TOKEN_SCOPE`, `GP_CONNECT_TOKEN_AUDIENCE`, `GP_CONNECT_TOKEN_REFRESH_FRACTION`.
  - `GP_CONNECT_MTLS_CERT_PATH`, `GP_CONNECT_MTLS_KEY_PATH`, `GP_CONNECT_MTLS_CA_PATH`, `GP_CONNECT_MTLS_WATCH`, `GP_CONNECT_MTLS_RELOAD_SIGNALS`.
- HTTP Adapter
  - `BOOKING_HTTP_CONCURRENCY` — per-route concurrency guard (defaults in code).
  - `BOOKING_READINESS_CACHE_MS` — readiness memoization window.
- Feature Flags
  - `feature_flags.gp_connect_booking` (default `false`) — when disabled, `/booking/appointments` responds `403` and clients should use `/booking/assisted` instead. Enable only after practices have opted into direct GP Connect autobooking.
- Observability
  - `BOOKING_LOG_LEVEL`, OpenTelemetry environment variables for tracing, and log sinks per deployment standards.

Error Handling
--------------
- Validation failures return `invalid_input` (HTTP 400) envelopes with structured errors (see `docs/ERRORS.md`).
- GP Connect timeouts, guard failures, or 5xx map to `upstream_unavailable` (HTTP 503); responses omit stack traces.
- Appointment conflicts surface as `conflict` (HTTP 409) with “Appointment slot already booked”; the state machine triggers a slot refresh to present updated availability.
- Exhausted publish attempts (two tries) emit DLQ events to `Topics.booking.appointmentCreatedDlq`, notify audit, and respond `upstream_unavailable`.

Events & Downstream Effects
---------------------------
- Success emits `Topics.booking.appointmentCreated` envelopes created with `createEnvelope(topic, payload, correlationId)` after validation via `validateAppointmentCreatedEvent`.
- Event payloads trace back to `schemas/booking/appointment-created.json`; PHI is limited to patient ID + hashes, location, and slot window.
- Queue notifications default to `booking.notifications`; payload includes slot metadata and hashed patient fingerprint for reconciliation.
- Audit trail writes `booking.appointment.created` records capturing appointment ID, originating task, correlation ID, and patient hash.
- DLQ emission uses the shared error envelope contract (`schemas/common/dlq-event.json`) with attempts/error codes for replay.
- Assisted outcomes publish `Topics.booking.assistedCompleted` envelopes (`schemas/booking/assisted-outcome.json`), recording task ID, outcome, optional Appointment reference, and staff metadata.

Metrics & Telemetry
-------------------
- `booking_http_duration_ms`, `booking_http_requests_total`, `booking_http_backpressure_total` monitor adapter load and throttling.
- GP Connect client emits `gp_connect_search_latency_ms`, `gp_connect_create_latency_ms`, `gp_connect_*_success_total`, `gp_connect_*_error_total`, and `gp_connect_create_conflict_total`.
- Token and certificate lifecycle tracked via `gp_connect_auth_refresh_*` and `gp_connect_cert_reload_*`.
- Events publish metrics increment `booking_event_publish_error_total` and `booking_event_dlq_total` when retries exhaust.

Testing & Playback Harness
--------------------------
- Deterministic fixtures under `fixtures/gpconnect/*.json` power `apps/booking/test/gpconnect.playback.test.ts`, providing offline playback for slot searches, successful bookings, and conflict retries.
- Run the playback suite with `npm run test -- apps/booking/test/gpconnect.playback.test.ts`; it exercises the state machine end-to-end, validates idempotency skips, and confirms conflict refresh behaviour.
- Broader suites: `npm run test -- apps/booking/test` and `npm run typecheck`.

Operational Guardrails
----------------------
- p50 HTTP latency targets 500 ms; p95 ≤ 1500 ms. Backpressure yields 429 responses while emitting `booking_http_backpressure_total`.
- Idempotency keys derive from hashed patient ID + slot ID + origin (`booking:${fingerprint}:${slotId}:${origin}`); stores must offer `reserve` semantics for at-most-once guarantees.
- Logs, audit, and DLQ artifacts exclude raw PHI; only hashed identifiers and slot references persist.
- OAuth tokens refresh ~15 % before expiry; mTLS certificates reload on signal/file change without restart.
- Monitor `forbidden` responses on `/booking/appointments`; sustained volume indicates `feature_flags.gp_connect_booking=false` without assisted fall-back enabled on the client side.

Example Flow
------------
```sh
CORR=$(uuidgen)

# Search for available slots
curl -X POST "$BOOKING_URL/booking/search" \
  -H 'content-type: application/json' \
  -H "x-correlation-id: $CORR" \
  -d '{
        "serviceType": "GP",
        "windowStart": "2025-10-18T08:00:00Z",
        "windowEnd": "2025-10-18T12:00:00Z",
        "location": "org-123"
      }'

# Book a slot using the returned slotId
curl -X POST "$BOOKING_URL/booking/appointments" \
  -H 'content-type: application/json' \
  -H "x-correlation-id: $CORR" \
  -H "x-idempotency-key: booking-$(uuidgen)" \
  -d '{
        "slotId": "slot-123",
        "patientId": "patient-456",
        "reason": "Follow-up consultation"
      }'

# Assisted booking when staff confirm inside EMIS/TPP
curl -X POST "$BOOKING_URL/booking/assisted" \
  -H 'content-type: application/json' \
  -H "x-correlation-id: $CORR" \
  -d '{
        "taskId": "Task/12345",
        "patientId": "Patient/456",
        "outcome": "booked",
        "slot": {
          "start": "2025-10-18T09:00:00Z",
          "end": "2025-10-18T09:15:00Z",
          "location": "org-123",
          "serviceType": "GP"
        },
        "recordedAt": "2025-10-18T08:45:00Z",
        "recordedBy": "clinician-12",
        "notes": "Booked manually at reception"
      }'
```

Further Reading
---------------
- ADR `docs/adr/2025-10-18-gp-connect-client.md` — client guardrails, retries, OAuth/mTLS.
- ADR `docs/adr/2025-10-20-booking-architecture-and-conflicts.md` — state orchestration, conflict refresh strategy, idempotent publishing. (Added in BE-04.15.)
