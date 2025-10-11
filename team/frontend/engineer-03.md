Engineer: Frontend 03

Role: Frontend Engineer (Accessibility/Localization)
Stack: Web, i18n

Responsibilities
- Accessibility & language support; interpreter preferences.

Initial Tasks
- Implement i18n strings; accessibility checks; language preference capture.

Start Here
- Algorithm.md: 0.5 Config (Accessibility and Language)
- Config: config/nhs_gp_defaults.yaml (accessibility_and_language)

Status: planned
Progress: 0%

Dependencies
- frontend/engineer-01 (Portal UX)
- backend/engineer-06 (Access Gate messages)

Platform Checklist (pre-flight)
- i18n framework configured; locale resources loaded; default locale set.
- Accessibility testing tools available; baseline criteria (contrast/focus) defined.
- No PII in logs; input sanitation for locale fields.

Tasks
- [ ] FE-03.1 — i18n library setup + locale switcher
- [ ] FE-03.2 — Language preference capture (patient.locale) in submission
- [ ] FE-03.3 — Accessibility baseline (focus, contrast) + fixes
- [ ] FE-03.4 — Interpreter preferences UI section (config-driven)
- [ ] FE-03.5 — Accessibility audit tooling in CI
 - [ ] FE-03.6 — RTL & bidirectional text support (dir, CSS logical props, bidi isolation)
 - [ ] FE-03.7 — ICU messages + extraction pipeline (plural/gender; key conventions)
 - [ ] FE-03.8 — Pseudo‑localization + missing‑key detection (build/CI checks)
 - [ ] FE-03.9 — Locale date/number/timezone formatting (12/24h; week start)
 - [ ] FE-03.10 — Content/readability review (plain language; inclusive terms)
 - [ ] FE-03.11 — Advanced a11y: forms, errors, live regions, focus/skip links
 - [ ] FE-03.12 — High‑contrast theme tokens and contrast audits (≥4.5:1)
 - [ ] FE-03.13 — Zoom/reflow compliance (200% zoom; no content loss)
 - [ ] FE-03.14 — Media/alt text guidelines (icons/illustrations; captions if added)
 - [ ] FE-03.15 — Localized error/envelope mapping (docs/ERRORS.md)
 - [ ] FE-03.16 — Performance: lazy‑load locale bundles; code‑split translations
 - [ ] FE-03.17 — Interpreter preferences: UI/validation/persistence (privacy‑safe)
 - [ ] FE-03.18 — Fallback logic & offline locale cache (graceful degradation)
 - [ ] FE-03.19 — A11y/i18n QA matrix (SR combos, devices, browsers) & test plan
 - [ ] FE-03.20 — Localization authoring guide (glossary, style, review process)
