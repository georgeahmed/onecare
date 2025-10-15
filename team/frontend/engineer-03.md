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

Status: in progress
Progress: 80%

Dependencies
- frontend/engineer-01 (Portal UX)
- backend/engineer-06 (Access Gate messages)

Platform Checklist (pre-flight)
- i18n framework configured; locale resources loaded; default locale set.
- Accessibility testing tools available; baseline criteria (contrast/focus) defined.
- No PII in logs; input sanitation for locale fields.

Tasks (Incomplete)
Completed tasks recorded in `team/frontend/Completed Tasks/engineer-03.md`.
- [ ] FE-03.10 — Content/readability review (plain language; inclusive terms). Remaining: establish review buddies and document sign-off flow; fold outcomes into the localization guide for day-to-day contributors.
- [ ] FE-03.11 — Advanced a11y: forms, errors, live regions, focus/skip links. Remaining: ship skip links across pages, tighten focus management for summary panels, and add screen reader-specific regression tests.
- [ ] FE-03.12 — High-contrast theme tokens and contrast audits (≥4.5:1). Remaining: document the contrast verification process and attach pa11y/axe reports per release.
- [ ] FE-03.14 — Media/alt text guidelines (icons/illustrations; captions if added). Remaining: author guidance for imagery/audio assets and link it from engineering + design docs.
