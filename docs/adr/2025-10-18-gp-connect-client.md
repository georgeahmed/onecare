# ADR: GP Connect Booking Client Architecture

**Date:** 2025-10-18  
**Status:** Accepted

## Context
The booking service integrates with NHS GP Connect for slot search and appointment creation. Earlier iterations scattered client responsibilities (auth headers, retries, correlation), making it difficult to reason about failure modes, conflict handling, and privacy guarantees. We also need an auditable record of how idempotency and correlation propagate between the booking workflow, GP Connect, and downstream events to satisfy IN-02.10.

## Decision
1. **Single Client Abstraction** – `GpConnectHttpClient` encapsulates HTTPS endpoint validation, API key auth (plus optional custom headers), and bounded timeouts. Calls execute via `callWithGuard` providing deterministic retries, jittered backoff, and circuit-breaker protection.  
2. **Correlation Propagation** – The guard injects `getCorrelationId()` into structured logs/metrics; downstream booking state machine records the same value in queue notifications, audit events, and `Topics.booking.appointmentCreated` envelopes.  
3. **Conflict Semantics** – GP Connect 409 responses map to a domain error (`booking.create.conflict`). The state machine treats conflicts as idempotent duplicates: it halts further side effects, preserves queue/audit integrity, and surfaces a user-friendly conflict response while still publishing DLQ telemetry when publish retries fail.  
4. **Idempotency & Hashing** – Appointment creation runs under `executeWithIdempotency`, keying on patient, slot, and organisation inputs. Patient identifiers are hashed before leaving the state boundary (queues, audit, logs) to meet privacy posture requirements.  
5. **Configuration Surface** – Environment variables (`GP_CONNECT_URL`, `GP_CONNECT_API_KEY`, optional timeout/auth overrides, and `GP_CONNECT_PRACTICE_ID`) are validated at startup. Insecure/private endpoints fail fast, preventing accidental misconfiguration.  
6. **Observability** – Metrics (`gp_connect_*`) capture latency, success/error counts, and conflict totals; structured logs emit operation names (`gpconnect.search`, `gpconnect.create`) with correlation IDs to support replay and incident response.

## Consequences
- The booking service has a single audited code path for GP Connect interactions, improving maintainability and easing future refactors (e.g., pooling, resilience tweaks).  
- Conflict behaviour is predictable and observable; retries do not generate duplicate downstream work or leak PHI.  
- Operational teams can rely on documented environment knobs and metrics when deploying or debugging integrations.  
- Future enhancements (e.g., async rendezvous, additional GP Connect endpoints) can build on the established guard/metrics/idempotency pattern without re-documenting core decisions.
