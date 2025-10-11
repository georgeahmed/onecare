AGENTS.md — Triage

Scope
- Applies to `apps/triage/*`.

Invariants
- Score = f(acuity, risk, complexity, time, capacity) with configured weights.
- SLA aging and de-dup must respect config thresholds.

Do
- Validate inputs; deduplicate with `dedup_window` and similarity threshold.
- Create Task with owner/priority; notify queue owner/team.

Don’t
- Don’t alter patient safety overrides; urgent diversion takes precedence.

Checklist
- [ ] Uses config weights; no hardcoded magic numbers
- [ ] De-dup window respected; similarity threshold configurable
- [ ] Task write-back schema-aligned
- [ ] Unit tests for scoring/aging logic

