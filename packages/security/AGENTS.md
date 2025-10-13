AGENTS.md — @onecare/security

Scope
- Applies to `packages/security/*`.

Rules
- Provide authN/Z helpers, consent checks, and audit hooks.
- No secret material in repo; read from env/secret stores.
- Small API surface; deterministic behavior, no side effects on import.

