AGENTS.md — Pharmacy Router

Scope
- Applies to `apps/pharmacy-router/*`.

Invariants
- Classify condition; check Pharmacy First eligibility; send CPCS referral (slot or slotless).

Do
- Respect exclusion rules (age/sex/severity/comorbidities).
- Notify patient with referral details; capture outcome and update GP task.

Don’t
- Don’t route eligible patients without explicit consent.

Checklist
- [ ] Rules configurable; no hardcoding
- [ ] Outcome write-back to FHIR
- [ ] Unit tests for eligible/not-eligible paths

