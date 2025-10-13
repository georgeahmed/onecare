AGENTS.md — Scribe Service

Scope
- Applies to `services-py/scribe_service/*`.

Rules
- Require clinician approval before record write-back.
- Respect token limits/uncertainty highlighting; expose settings via config.
- Optional audio storage must be explicit and consented.

Checklist
- [ ] Input validation; diarization handled per config
- [ ] Approval workflow enforced; write-back structures valid
- [ ] Tests for transcript/draft happy path

