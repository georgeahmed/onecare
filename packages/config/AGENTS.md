AGENTS.md — @onecare/config

Scope
- Applies to `packages/config/*`.

Rules
- Implement layered config (global → ICS → PCN → practice). Deterministic merges.
- Enforce floors/ceilings and provenance where applicable.
- No I/O on import; explicit `load` functions.

