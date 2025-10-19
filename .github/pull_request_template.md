## Summary

Briefly describe the change and its intent.

## Checklist (copy from AGENTS.md)

- Contracts:
  - [ ] Schema updated (if needed) in `schemas/` and codegen run
  - [ ] TS contracts updated in `packages/events/src/contracts`
  - [ ] Python models updated in `services-py/common/contracts/models.py`
- Code:
  - [ ] TypeScript typed; Python hinted; no `any`
  - [ ] Small, focused changes; correct layer (state vs adapter)
- Tests:
  - [ ] Unit tests added/updated; no real network calls
- Docs:
  - [ ] Service README updated (endpoints, env vars, examples)
  - [ ] docs/USAGE.md updated if commands/scripts changed
  - [ ] ADR added/updated if design decision changed
- Security:
  - [ ] Input validation & SSRF guardrails applied; timeouts + bounded retries on outbound calls
  - [ ] AuthZ/consent enforced; audit events added when required
- Secure Coding:
  - [ ] Checklist in `docs/security/SECURE_SDLC.md` complete (secure coding guide followed, tests cover security cases)
  - [ ] SAST/DAST findings triaged or suppressed with justification; no new secrets introduced
- Build:
  - [ ] TS project references valid; CI green

## Screenshots / Logs

Optional UI/API examples and logs (sanitized).
