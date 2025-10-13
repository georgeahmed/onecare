AGENTS.md — @onecare/events

Scope
- Applies to `packages/events/*`.

Rules
- Contracts are generated from `schemas/`. Do not hand-edit generated files.
- Topics constants mirror `infra/event-bus/topics.md` and Algorithm.md.
- Add version fields in payloads if/when needed for consumer compatibility.
 - Schema style: prefer `additionalProperties: false`, camelCase, required fields explicit, and `format` annotations.
 - Envelope: prefer typed publishing using `TypedEnvelope<T>` via `createEnvelope(topic, payload, correlationId)` and include `correlationId` when available.

Checklist
- [ ] Schema updated; codegen run; exports updated
- [ ] No breaking changes without version bump
