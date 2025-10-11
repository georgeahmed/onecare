AGENTS.md — Safety Gate Service

Scope
- Applies to `services-py/safety_gate_service/*`.

Rules
- Enforce timeout; provide deterministic fallback (rules) on ML timeout/failure.
- No storage of raw audio/text unless explicitly configured; respect retention.
- Return `DIVERTED` only on high confidence or lexicon match per config.

Checklist
- [ ] Inputs validated; errors do not leak PHI
- [ ] Timeout + fallback covered by tests
- [ ] Configurable thresholds; no magic numbers

