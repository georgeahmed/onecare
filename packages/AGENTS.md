AGENTS.md — packages/ (TypeScript Libraries)

Scope
- Applies to all shared libraries under `packages/`.

Principles
- Keep packages small, focused, and free of network I/O.
- Provide stable exports via `src/index.ts`. Avoid leaking deep paths.
- Maintain strict types; no `any` unless encapsulated and justified.

Statekit
- Keep `@onecare/statekit` minimal and framework-agnostic. No domain-specific logic.

Events
- `@onecare/events` mirrors `schemas/`. Do not hand-edit generated contracts; run codegen instead.

Domain/Config/Security/Observability
- Keep domain types light; avoid re-implementing FHIR.
- Config loader should be deterministic and testable; avoid side effects on import.
- Security and observability libs must not depend on app code.

Testing
- Add unit tests next to packages (e.g., `packages/<name>/test/*`).

