Engineer: Frontend 01

Role: Frontend Engineer (Portal)
Stack: Web, TypeScript

Responsibilities
- Portal intake aligned to schemas/ingest/portal-submission.json

Initial Tasks
- Build form + validation; submit to orchestrator ingress (dev).

Start Here
- Algorithm.md: 2) Access Front Door
- Schemas: schemas/ingest/portal-submission.json
- Docs: docs/USAGE.md (endpoints)
 - A11y/i18n: team/frontend/engineer-03.md (cross‑links for RTL, high‑contrast, ICU, QA)

Status: stable
Progress: 100%

Dependencies
- backend/engineer-01 (Orchestrator)
- backend/engineer-06 (Access Gate)
 - frontend/engineer-03 (Accessibility/Localization)

Platform Checklist (pre-flight)
- Orchestrator/Access Gate endpoints and ports known; CORS configured; environment variables set.
- Contract alignment with schemas/ingest/portal-submission.json; client-side validator matches server.
- Error envelope renderer matches docs/ERRORS.md; correlationId propagated via x-correlation-id.
- Rate limits/backpressure messages handled gracefully (429/503); retry/backoff UX acceptable.
- Observability (front-end): add correlationId to logs (dev), avoid PII in console logs.
 - Accessibility baseline meets WCAG 2.2 AA (focus order, keyboard nav, ARIA, contrast ≥4.5:1). High‑contrast theme available.
 - Internationalization ready: ICU messages, locale switcher, RTL support, lazy‑loaded locale bundles; pseudo‑locale QA.
 - Design System: use shared design tokens (colors/spacing/typography/motion); dark/high‑contrast themes respected.
 - Performance budgets defined (LCP/INP/CLS) and measured locally; code‑split/lazy‑load noncritical routes.
 - PWA offline queue enabled for submission; secure storage with minimal PII; CSP hardened; no PII in logs.

Tasks
Completed
- [x] FE-01.1 — Scaffold portal intake form (practiceId, patient.id, narrative, channel)
- [x] FE-01.2 — Client-side JSON Schema validation for submission (errors inline)
- [x] FE-01.3 — Error envelope renderer per docs/ERRORS.md
- [x] FE-01.4 — POST /safety-check with x-correlation-id; display SafetyDecision
- [x] FE-01.5 — i18n scaffolding for labels/messages (en default)
- [x] FE-01.6 — Loading/disabled states + retry/backoff for network errors
- [x] FE-01.7 — Schema-driven form (optional)
- [x] FE-01.8 — Accessibility WCAG 2.2 AA (focus, keyboard, ARIA, contrast)
- [x] FE-01.9 — Design System + Design Tokens (themes, dark/high-contrast)
- [x] FE-01.10 — Internationalization & Localization (RTL, locale formats)
- [x] FE-01.11 — Form UX excellence (inline validation, error summary, autosave drafts)

In Scope (Next)
- [ ] FE-01.12 — Progressive disclosure & wizard flow (branching; save/resume) _(Plan: 1) define stage/state machine in `src/application/intakeWizard.state.ts`; 2) split SchemaForm into step components with guardrail validation per stage; 3) persist step progress via existing autosave envelope so resume works; 4) add routing + analytics events for step transitions.)_
- [ ] FE-01.16 — Friendly error states (429/503/504 mapping; copy/backoff UX) _(Plan: 1) build shared `ErrorView` component consuming contract codes + retry-after countdown; 2) extend `submitIntake` to surface retry metadata (429 headers) and wire to new view; 3) capture telemetry + copy review, then reuse for booking flow to keep parity.)_
- [ ] FE-01.19 — Testing: e2e (Playwright), a11y (axe), contract (Ajv), unit _(add error-state/mobile coverage and contract fixtures after new flows land)_

Deferred (Next Milestone)
- [ ] FE-01.13 — Performance budgets (Core Web Vitals: LCP/INP/CLS) and asset optimization _(needs analytics/observability wiring first)_
- [ ] FE-01.14 — Offline-ready PWA (service worker, background sync, offline queue) _(defer until backend offline contract defined)_
- [ ] FE-01.15 — Security & privacy (CSP, XSS/CSRF guardrails; no PII in logs) _(coordinate with security review to land CSP/header updates)_
- [ ] FE-01.17 — Frontend observability (correlationId, structured logs, RUM metrics) _(implement alongside platform telemetry work)_
- [ ] FE-01.18 — Visual polish & micro-interactions (motion guidelines, skeletons) _(execute after primary flows finalize)_
- [ ] FE-01.20 — Documentation & design guidelines (content style, components) _(expand README into full guidelines post-theme adoption)_
- [ ] FE-01.21 — Content & localization QA (readability, inclusive language) _(schedule dedicated content review once copy stabilizes)_
- [ ] FE-01.22 — Responsive QA and device/browser matrix (mobile‑first) _(align with QA automation scope before investing)_
- [ ] FE-01.23 — State/data architecture (query caching, retries, error boundaries) _(blocked on shared data layer RFC)_
