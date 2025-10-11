AGENTS.md — schemas/ (Contracts)

Scope
- Applies to all JSON Schemas under `schemas/`.

Practices
- Treat schemas as the source of truth for public contracts.
- Include `$schema` and a globally unique `$id` with version hints. Use semver-inspired names when breaking changes are introduced.
- Keep schemas small and composable. Prefer references to common structures (e.g., event envelopes) where appropriate.
- After schema changes, run codegen to update TS (`@onecare/events`) and Python (`services-py/common/contracts`).
- Add/adjust minimal contract tests where critical paths depend on schema validation.

Naming
- Use kebab-case file names and keep directories by domain (ingest/, triage/, booking/, pharmacy/, scribe/, common/).

