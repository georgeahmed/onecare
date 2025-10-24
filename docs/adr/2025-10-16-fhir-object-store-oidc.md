# ADR: Hardened FHIR/Object Store/OIDC Integrations

* Status: Accepted
* Date: 2025-10-16

## Context

The orchestrator depends on the NHS FHIR repository, an object store for binary artifacts, and NHS Login for identity. Earlier changes added the raw clients, but left several gaps:

- Outbound base URLs were not constrained to HTTPS/non-local hosts, creating SSRF risk.
- The FHIR client lacked GET support, circuit breaker protection, Retry-After handling, and If-Match coordination for idempotent updates.
- Consent flows returned a boolean flag which hid the underlying reason, complicating observability and enforcement.
- Health/readiness probes only reflected bus connectivity, offering no signal for FHIR/Object Store/OIDC availability.
- Tests/port helpers did not encode the new behaviours.

## Decision

1. Introduced `assertHttpsUrl` in `apps/orchestrator/src/index.ts` to validate scheme, host, credential absence, and default port injection for `FHIR_BASE_URL` and `OBJECT_STORE_BASE_URL`. The orchestrator now refuses to boot if base URLs are non-HTTPS or private.
2. Extended `HttpFhirRepository` to:
   - Log dispatch/success/failure using the redacting logger.
   - Support GET via `readResource`, Prefer headers, and conditional `If-Match` updates.
   - Honour `Retry-After`, implement exponential backoff with jitter, and expose a configurable circuit breaker with half-open recovery.
   - Treat 409/412 conflicts on idempotent operations as handled outcomes.
3. Updated the ports layer to surface read options and update options, and added tests for Binary uploads and GETs.
4. Enriched consent APIs with typed decisions, correlation-aware logs, and evidence caching.
5. Extended `/health` and `/ready` endpoints to emit dependency status (FHIR/Object Store/OIDC) with cached probe results.

## Consequences

- SSRF/TLS misconfiguration now fails fast at startup, reducing risk but requiring correct env configuration.
- Circuit breaker and Retry-After logic prevent cascading failure but add complexity; metrics and logs capture state transitions (`fhir.circuit.*`).
- GET/If-Match support allows downstream services to perform idempotent reads/updates without bypassing the port interfaces.
- Tests cover the new behaviour (see `apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts`, `packages/security/test/oidc.test.ts`, `packages/ports/test/fhir.test.ts`, `apps/orchestrator/test/readiness.test.ts`).
- Documentation aligns team status and completed tasks for IN-01.1/01.4/01.5/01.9/01.10/01.11/01.12/01.13.

## Follow-up

- Still need to document performance baselines, redact additional payloads, and finish ADR coverage for other teams (IN-01.16…01.19).
