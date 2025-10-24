# ADR: Booking Event DLQ & Guardrails

**Date:** 2025-10-15  
**Status:** Accepted

## Context
The booking service publishes `booking.appointment.created` envelopes after successfully writing appointments to GP Connect and FHIR. Failures in publishing, outbound resilience guardrails, and privacy telemetry were previously incomplete (see BE-04.6, BE-04.7, BE-04.8, BE-04.11–04.14).

## Decision
1. **DLQ Flow** – Added `Topics.booking.appointmentCreatedDlq` and publish failures now emit a `DlqEvent` with retry metadata (`attempts`, `errorCode`, `payloadRef`) after two guarded retries.  
2. **Outbound Guardrails** – Introduced `callWithGuard` wrappers for GP Connect, FHIR write-back, and bus publishing with bounded retries, circuit breaker semantics, and structured logs/metrics. GP Connect endpoints must be HTTPS and non-private.  
3. **HTTP Adapter** – Exposed `/booking/search`, `/booking/appointments`, `/healthz`, and `/readyz`, enforcing JSON contracts, concurrency caps (429), and consistent error envelopes while emitting duration/backpressure metrics.  
4. **Privacy** – Idempotency keys and notifications use hashed patient fingerprints; logs avoid raw PHI while preserving correlation identifiers for traceability.  
5. **Performance & Observability** – New metrics (`booking_http_duration_ms`, `booking_http_requests_total`, `booking_http_backpressure_total`) track latency, volume, and throttling. README documents p50/p95 expectations and monitoring cues.

## Consequences
- Booking consumers can inspect DLQ entries with sufficient context for replay without exposing PHI.  
- Configuration now fails fast for insecure/private GP Connect endpoints.  
- Operations gain visibility into request pressure and failure reasons while meeting privacy requirements.  
- Fault-injection tests cover publish failures; future work should extend coverage for FHIR/network timeouts and SSRF allowlists.
