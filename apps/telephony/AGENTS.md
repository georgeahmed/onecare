AGENTS.md — Telephony

Scope
- Applies to `apps/telephony/*`.

Invariants
- Parity with web flow; ASR transcript → safety gate → triage.

Checklist
- [ ] Caller identity verification; map to patient
- [ ] Intent classification configurable; callback windows offered per priority
- [ ] Fallback to human operator on failure

