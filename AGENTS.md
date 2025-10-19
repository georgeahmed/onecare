ONECARE • AGENTS.md

Purpose
- Enforce practical, industry-grade guidance for agents and humans working in this repo: coding, documentation, testing, security, and release practices.

Scope
- Applies to the entire repository unless overridden by a more specific AGENTS.md in a subfolder (apps/, packages/, services-py/, schemas/, infra/, config/, docs/).

Guiding Principles
- API/Contract first: modify JSON Schemas in `schemas/` before code. Regenerate TS/Python models and then implement.
- State-class architecture: business decisions in `src/application/*state.ts`; side effects in `src/adapters/*`.
- Separation of concerns: no business logic in adapters; no network I/O in shared `packages/*`.
- Safety and compliance: treat all PHI/PII carefully; default to minimum necessary data and explicit consent.
- Small, focused patches: change only what’s needed; avoid drive-by refactors.

Naming & Layout
- Filenames: kebab-case for files, camelCase for properties, PascalCase for types/classes.
- Tests: `*.test.ts` colocated under `test/` or near source; Python tests under `services-py/tests` with `test_*.py`.
- Directories: `src/application` (states), `src/adapters` (I/O), `src/dev` (dev-only helpers), `test` (unit tests).

Error Handling & Results
- HTTP: return structured errors; no stack traces to clients. Use a consistent error envelope (see `docs/ERRORS.md`).
- Events: failures should be retried with backoff or sent to DLQ; never publish partial/invalid payloads.
- Prefer explicit Result/Decision objects between layers over throwing; throw only for truly exceptional cases.

Timeouts, Retries, Idempotency
- Outbound HTTP calls: default timeout 2s (configurable), max 2 retries with exponential backoff (jitter), idempotent operations only.
- Event handlers: ensure idempotency using an `IdempotencyStore`; include idempotency keys where applicable.
- Correlation: propagate `x-correlation-id` in HTTP headers and `correlationId` in event envelopes.

Code Practices (TypeScript)
- Strict typing, zero `any` unless boxed. Reuse contracts from `@onecare/events`.
- Keep functions/states small and testable; favor pure functions in `packages/*`.
- Validate inputs at edges (HTTP/event ingress). Consider zod/JSON Schema validation where helpful.
- Avoid CPU-heavy work; call Python ML services instead.
- Project references must remain valid; don’t break incremental builds.

Code Practices (Python)
- Use FastAPI + Pydantic (generated models). Type hints everywhere.
- Stateless endpoints; avoid globals. Prefer dependency injection.
- Format with Black; lint with Ruff; tests with Pytest.

Documentation Practices
- Schemas are the source of truth. Keep `$id` versioning coherent and bump on breaking changes.
- Update service READMEs when adding endpoints, env vars, or behavior. Include example curl commands.
- Prefer ADRs in `docs/adr/` for decisions that affect design/API; keep them short and dated.
- Update `docs/USAGE.md` with any new commands, scripts, or run modes. PRs that add scripts must update USAGE.
- Use `docs/RELEASE_READINESS.md` (service-level) and `docs/SYSTEM_READINESS.md` (system-level) to track go/no-go gates.
- Keep team status consistent: update `team/*/engineer-*.md` (Status/Progress/Tasks). Use `make team-status-write` to sync Progress.
 - After marking a task done, run `make team-status-write` — it auto-commits status changes and pushes to the `dev` branch so progress stays in sync for agents.

Testing Practices
- Unit tests first: TS (Vitest under `packages/*/test` or `apps/*/test`), Python (Pytest under `services-py/tests`).
- Contract tests: validate critical payloads against JSON Schemas.
- Keep tests deterministic and fast; no network in unit tests. Use http mocks/fakes.

Security & Privacy Checklist
- Do not log PHI/PII or secrets. Redact tokens/IDs; use correlation IDs.
- Enforce authN/Z + consent at the orchestration boundary. Deny by default.
- Timeouts on all outbound calls; retries are bounded with backoff; idempotency keys on ingress.
- Validate and sanitize all inputs, including filenames/URLs.
- Respect retention and minimization policies in `config/`.
- Apply the subject/action scopes in `docs/SECURITY_AUTHZ.md`; capture consent + audit evidence as defined.
- Follow secure coding guides (`docs/security/SECURE_CODING_NODE.md`, `docs/security/SECURE_CODING_PY.md`) and Secure SDLC checklist (`docs/security/SECURE_SDLC.md`).
- Ensure SAST/DAST findings are triaged and no secrets are introduced (see `docs/security/APPLICATION_SECURITY.md`, `docs/security/SECRETS_PREVENTION.md`).

Data Handling & FHIR Guidance
- Never publish PHI-rich resources on the broker; share IDs/refs, not full `Patient` resources.
- Persist via FHIR transaction bundles where possible; validate against profiles when available.
- Use `DocumentReference`/`Binary` for large artifacts; store out-of-band, share references.

Schema & Event Design
- Default `additionalProperties: false`; prefer explicit fields and types.
- Include `$id` with semantic versioning hints; use camelCase property names.
- Use string `format` where applicable (date-time, date, uri).
- Event payloads should be small and self-descriptive; include stable IDs in payloads, not only in envelope.
- Prefer typed envelopes using `TypedEnvelope<T>` (alias over generated `EventEnvelope`) and the `createEnvelope(topic, payload, correlationId)` helper; see `docs/EVENTS.md`.

Performance & Reliability
- Set time budgets for states; add fallbacks for gates (e.g., safety gate rules fallback on timeout).
- Avoid synchronous blocking; prefer async I/O and short critical sections.
- Use circuit breakers around flaky dependencies; emit metrics for failures and latency.

Contracts & Versioning
- Backwards-compatible changes: additive fields allowed; never repurpose semantics.
- Breaking changes: bump schema version (`$id`), publish migration notes, maintain dual-read/dual-publish when feasible.
- Deprecations: mark fields/topics as deprecated and remove after a release window.

Event Envelope & Bus
- Prefer publishing typed envelopes using `createEnvelope(topic, payload, correlationId)` from `@onecare/events` and annotate handlers with `TypedEnvelope<T>`.
- Use `@onecare/bus` abstraction in services; in tests or dev, `MemoryBus` is acceptable.
 - See `docs/adr/2025-10-11-bus-injection.md` for adapter factory/injection, topic allowlist, envelope validation, and correlation propagation at the adapter boundary.

Branching, Commits, PRs
- Branches: feature/*, fix/*, chore/*, docs/*.
- Commits: Conventional Commits style (feat:, fix:, docs:, chore:, refactor:, test:, build:).
- PRs: small, linked to issues; include checklist (tests updated, docs updated, schemas updated if changed).

Observability
- Emit structured logs, metrics, and traces; prefer OpenTelemetry where possible.
- Define SLOs and error budgets per service; alert on sustained breaches.

Workflow for Changes
1) Check AGENTS.md here and any subfolder variants.
2) If changing contracts, edit `schemas/*` first. Run codegen for TS/Python models.
3) Apply minimal code changes in the correct layer (state vs adapter vs package).
4) Add/adjust tests. TS: `npm run typecheck && npm run test`. Python: `pytest`.
5) Update docs/READMEs and ADRs as needed.

Directory Conventions
- apps/: services (HTTP/event adapters + state classes)
- packages/: shared libraries (pure or near-pure)
- services-py/: ML services (FastAPI)
- schemas/: master JSON Schemas (versioned `$id`)
- infra/: operational docs (topics/brokers, persistence notes)
- docs/: architecture, ADRs, conventions

Do / Don’t (Quick)
- Do keep patches minimal, typed, and tested.
- Do validate inputs and guardrail external calls with timeouts.
- Don’t refactor unrelated areas in the same PR.
- Don’t add licenses/headers unless explicitly requested.

Review Checklist (paste into PR)
- Contracts: [ ] Schema updated (if needed) and codegen run
- Code: [ ] Typed (TS), hinted (Py); small functions; no `any`
- Tests: [ ] Unit tests added/updated; no network
- Docs: [ ] README updated; USAGE updated; ADR added/updated if design change
- Security: [ ] Validations + SSRF guardrails; timeouts/retries; no PHI/secrets in logs
- Secure Coding: [ ] Checklist in `SECURE_SDLC.md` satisfied; SAST/DAST findings triaged; secrets sourced from Vault
- Build: [ ] TS project references valid; CI green
- Performance: [ ] Timeouts set; no CPU-bound code in Node; backpressure considered
- Observability: [ ] Correlation IDs propagated; key spans/logs present

Agent Automation Checklist
- Edit schemas first; run `npm run codegen` (or `codegen:check`).
- Make minimal, typed changes in correct layers (application vs adapters).
- Run `npm run typecheck && npm run test` locally; keep tests fast/deterministic.
- Update team status checkboxes, and run `make team-status-write` to sync.
 - `make team-status-write` will auto-commit and push to `dev`.
- Review `docs/RELEASE_READINESS.md` before merging; ensure cross-team gates are tracked.
