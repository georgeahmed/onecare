Project Conventions

Folders
- apps/<service>/src/application: state classes and machines
- apps/<service>/src/adapters: I/O integrations (http, events, persistence)
- packages/statekit: shared state-machine helpers
- packages/events: topics/constants
- packages/domain: domain types
- packages/config, security, observability: stubs for common concerns

Style
- Keep state classes small and single-responsibility.
- No business logic in adapters; keep side-effects in adapters, transitions in states.
- Emit metrics/audit on transitions.

Localization Authoring Guide
- Glossary
  - `practice` → OneCare clinic; use “practice” consistently (no synonyms).
  - `patient` → “person seeking care” when space allows; otherwise “patient”.
  - `interpreter` → “language interpreter”; avoid “translator” unless translating documents.
- Tone & Readability
  - Write plainly at an 8th-grade reading level; avoid idioms and clinical jargon.
  - Prefer active voice and short sentences (20 words or fewer).
  - Provide actionable guidance first, then optional background context.
  - Acknowledge constraints empathetically (“Hang tight while we retry.”) without blaming the user.
  - Replace medical shorthand with inclusive alternatives (“person seeking care”, “support team”).
- Key Naming Conventions
  - Keys follow `domain.section.message` (e.g. `intake.interpreter.notes.label`).
  - Shared UI affordances use `ui.*`; error envelope strings map to codes in `docs/ERRORS.md`.
  - Add new keys to `apps/portal/src/i18n/messages/en.ts` and mirror them in every locale file.
- Workflow
  1. Add English copy in `messages/en.ts` and update translated bundles (`messages/es.ts`).
  2. Run `npx tsx apps/portal/scripts/i18n/extract.ts` to regenerate `apps/portal/locales/*.json`.
  3. Run `npm run i18n:portal:check` (or CI) to confirm no keys are missing or stale.
  4. Use the “Pseudo (debug)” locale in dev to surface truncation, overflow, and placeholder mistakes.
  5. Document any reviewer context or glossary additions alongside the change set.
- Content & Readability Review Lane
  - Open a review ticket and assign the Content Reviewer rotation. When the optional `team/` backlog is mounted, consult `team/frontend/engineer-01.md` for the roster (context lives in `docs/TASK_INDEX.md`); otherwise follow the shared rotation tracker.
  - Reviewer checklist: verify plain-language tone, sentence length, glossary adherence, and inclusive alternatives.
  - Capture decisions in `docs/ADR/` when wording changes product behaviour or patient expectations.
  - Update the localization glossary and link the ticket in the PR description; add QA notes to `docs/USAGE.md` matrix when new flows ship.
- Review & QA
  - Validate pluralisation/gender in ICU strings before handing off to translation.
  - Exercise the QA matrix in `docs/USAGE.md` (screen reader + browser/device combos) for new flows.
  - Capture updates in the localization glossary and notify translators via shared channel.

Booking Microcopy Patterns
- Use action-led headings (“Confirm appointment”) and surface the next step before context.
- Summaries should restate the slot, modality, and time zone; confirmations must include the booking reference and correlation ID.
- Conflict or retry notices always present an option (“Try again now”) before explanation.
- Offline copy explains what the system is doing (“We queued your confirmation…”) and reassures the user that data is safe.
- Avoid panic words (“critical failure”, “fatal error”)—keep tone calm and solution-oriented.

UI Component Guidelines
- Buttons: `ui-button` for primary actions, `ui-button--subtle` for safe exits. Keep focus order logical and never disable without showing progress.
- Inputs: pair with explicit `<label>` text, keep helper text concise, and render errors directly below the control.
- Alerts/Banners: use `ui-alert` for persistent notices; reserve toast-style banners for passive confirmations.
- Layout: constrain key forms to `max-width: 720px`, leverage the spacing tokens (`--space-*`) instead of pixel constants.
- Dialogs: mirror `booking` confirm dialog semantics (`aria-labelledby`, `aria-describedby`, focus trap). Close on `Escape` only when safe.

Media & Alt Text Guidelines
- Provide descriptive, task-oriented alt text for informative imagery (who/what/action). Keep it under 125 characters when possible.
- Mark purely decorative icons with `aria-hidden="true"` and empty `alt=""`; avoid redundant phrasing already expressed in adjacent text.
- Supply captions or transcripts for audio/video content before publication; reference the transcript location in release notes.
- Record ownership for captions/alt text in the Content Reviewer checklist and link updates in `apps/portal/README.md`.
- Coordinate with Design when updating illustrations to ensure colour usage remains WCAG AA compliant (contrast verified via `npm run a11y:portal`).
- Follow the detailed checklist in `docs/UX/ALT_TEXT_GUIDE.md`; reference it in PR descriptions whenever new media ships.

Service Platform Checklist Template
- Broker & Topics
  - Broker reachable (NATS/Kafka) with TLS/credentials; firewall/egress allowed. See: infra/runbooks/tls-credentials.md
  - Subjects/streams created for topics and DLQ; subject ACLs and retention configured. See: infra/event-bus/subjects-acls.md, infra/event-bus/dlq-runbook.md
- Contracts & Codegen
  - JSON Schemas updated first; run TS/Python codegen; compile validators (Ajv/Pydantic) at ingress and before publish; CI drift guard in place.
- Idempotency Store
  - Redis (or equivalent) provisioned; reserve semantics available; TTL configured; keys exclude PHI. See: infra/runbooks/idempotency-store.md
- Observability
  - CorrelationId propagation; structured logs (no PHI), metrics (counters/histograms), and OpenTelemetry traces configured.
- Security
  - SSRF allowlists for outbound calls; TLS verification; header/input sanitation; deny-by-default for missing consent.
- Outbound client adapters (CPCS, GP Connect, ICS) must redact secrets from logs, propagate correlation IDs, and reuse shared guard rails (timeouts, retries, circuit breakers).
- Object Store integrations must never log binary contents or raw URLs that could expose PHI; always log redacted keys (`hash(patientId)`), propagate `x-correlation-id`, and store artifacts via HTTPS endpoints that pass SSRF validation (`assertHttpsUrl`). See `apps/orchestrator/src/adapters/persistence/object-store.client.ts` for the reference implementation.
- Backpressure & Rate Limits
  - Concurrency caps (semaphore) and per-tenant token-bucket limits; 429/503 envelopes; pressure metrics.
- Health & Shutdown
  - /healthz and /readyz endpoints reflecting dependencies; graceful drain on SIGTERM.
- Privacy & Retention
  - Redaction helpers; PHI minimization in payloads; retention windows documented and enforced.
- Performance & Fault Injection
  - Perf scripts (autocannon) for p50/p95 baselines; fault-injection tests for timeouts/retries/CB/DLQ; budgets documented.

Web Security Baseline
- CSP is shipped via `<meta http-equiv="Content-Security-Policy">` (see `apps/portal/index.html`). Do not introduce inline scripts/styles; if a framework requires it, add a nonce and document the review.
- Sanitize all user-provided text with `lib/security.ts` before storing or rendering; `ensureHttpsUrl` validates attachment links and `redactForLog` removes secrets from telemetry/logs.
- The portal service worker caches the shell and queues background submissions. When touching offline code, ensure headers and payloads exclude PHI and reuse the existing retry/backoff logic.
- Console logging is disabled in production builds. Never log PII/PHI in development—lean on correlation IDs for debugging.

Usage
- Copy this checklist into each service’s engineer file under “Platform Checklist (pre-flight)” and tailor specifics (endpoints, creds, topics).
- Link service-specific run/runbook docs from READMEs.
