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

Status: planned
Progress: 0%

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
- [ ] FE-01.1 — Scaffold portal intake form (practiceId, patient.id, narrative, channel)
- [ ] FE-01.2 — Client-side JSON Schema validation for submission (errors inline)
- [ ] FE-01.3 — Error envelope renderer per docs/ERRORS.md
- [ ] FE-01.4 — POST /safety-check with x-correlation-id; display SafetyDecision
- [ ] FE-01.5 — i18n scaffolding for labels/messages (en default)
- [ ] FE-01.6 — Loading/disabled states + retry/backoff for network errors
- [ ] FE-01.7 — Schema-driven form (optional)
 - [ ] FE-01.8 — Accessibility WCAG 2.2 AA (focus, keyboard, ARIA, contrast)
 - [ ] FE-01.9 — Design System + Design Tokens (themes, dark/high-contrast)
 - [ ] FE-01.10 — Internationalization & Localization (RTL, locale formats)
 - [ ] FE-01.11 — Form UX excellence (inline validation, error summary, autosave drafts)
 - [ ] FE-01.12 — Progressive disclosure & wizard flow (branching; save/resume)
 - [ ] FE-01.13 — Performance budgets (Core Web Vitals: LCP/INP/CLS) and asset optimization
 - [ ] FE-01.14 — Offline-ready PWA (service worker, background sync, offline queue)
 - [ ] FE-01.15 — Security & privacy (CSP, XSS/CSRF guardrails; no PII in logs)
 - [ ] FE-01.16 — Friendly error states (429/503/504 mapping; copy/backoff UX)
 - [ ] FE-01.17 — Frontend observability (correlationId, structured logs, RUM metrics)
 - [ ] FE-01.18 — Visual polish & micro-interactions (motion guidelines, skeletons)
 - [ ] FE-01.19 — Testing: e2e (Playwright), a11y (axe), contract (Ajv), unit
 - [ ] FE-01.20 — Documentation & design guidelines (content style, components)
 - [ ] FE-01.21 — Content & localization QA (readability, inclusive language)
 - [ ] FE-01.22 — Responsive QA and device/browser matrix (mobile‑first)
 - [ ] FE-01.23 — State/data architecture (query caching, retries, error boundaries)
