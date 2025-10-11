AGENTS.md — Orchestrator

Scope
- Applies to `apps/orchestrator/*`.

Invariants
- Zero-trust: verify signature + replay guard; authorize + consent check before any processing.
- FHIR-first: normalize to FHIR, validate profiles, transactional upsert before enrich/route.
- Safety gate: call safety service early; enforce timeout + fallback to rules.

Do
- Validate ingress payloads against schemas; reject invalid.
- Emit audit events for deny/invalid/success; include correlation IDs.
- Keep state transitions small and ordered: Received → Authorized → ConsentChecked → Normalized → Validated → Persisted → Enriched → Routed → Audited.

Don’t
- Don’t bypass consent checks, even for internal callers.
- Don’t log PHI; log IDs only and redact fields.

Checklist
- [ ] Contract types used from `@onecare/events`
- [ ] Safety call guarded with timeout; rules fallback present
- [ ] Audit and metrics emitted at key points
- [ ] Tests cover deny + happy path

