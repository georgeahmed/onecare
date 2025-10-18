Engineer: Frontend 06

Role: Clinician Dashboard — UX, A11y, i18n, Design System
Stack: Web, TypeScript, React

Responsibilities
- Establish design tokens/themes; WCAG 2.2 AA baseline; i18n (ICU) with pseudo‑locale; high‑contrast; accessibility audit in CI; content/readability review lane wiring.

Start Here
- Patterns to reuse: apps/portal/src/i18n, apps/portal/src/styles/tokens.css, apps/portal/scripts/a11y-ci.ts
- Authoring: docs/CONVENTIONS.md (localization & content lane), docs/USAGE.md (QA matrix)

Status: planned
Progress: 0%

Dependencies
- frontend/engineer-04/05 for component adoption

Platform Checklist (pre-flight)
- Skip links, focus order, keyboard flows, ARIA for dynamic regions
- High‑contrast and reduced‑motion support; pseudo‑locale QA; no PHI in console logs

Tasks
- [ ] FE-06.1 — Design tokens + theme alignment with Portal (light/dark/high‑contrast)
- [ ] FE-06.2 — App shell a11y: skip links, labelled navigation, focus trapping where needed
- [ ] FE-06.3 — i18n setup (ICU), locale bundles, pseudo‑locale, missing‑key checks
- [ ] FE-06.4 — Accessibility audit script integration + CI step for the new app
- [ ] FE-06.5 — Content/readability review lane hooks; microcopy for empty/loading/error states
- [ ] FE-06.6 — Privacy guardrails: minimum necessary display; screenshot‑safe/blur mode for demos
- [ ] FE-06.7 — Observability: surface correlation IDs; RUM metrics stub; basic counters for actions
- [ ] FE-06.8 — Unit tests for a11y flows (skip links, focus order) and i18n fallbacks

