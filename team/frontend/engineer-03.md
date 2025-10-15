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
Progress: 35%

Dependencies
- frontend/engineer-01 (Portal UX)
- backend/engineer-06 (Access Gate messages)

Platform Checklist (pre-flight)
- i18n framework configured; locale resources loaded; default locale set.
- Accessibility testing tools available; baseline criteria (contrast/focus) defined.
- No PII in logs; input sanitation for locale fields.

Tasks (Incomplete)
Completed tasks recorded in `team/frontend/Completed Tasks/engineer-03.md`.
- [ ] FE-03.6 — RTL & bidirectional text support (dir, CSS logical props, bidi isolation). Remaining: add document direction toggles and logical CSS; provider currently only sets `lang` (`apps/portal/src/i18n/index.tsx:94`).
- [ ] FE-03.7 — ICU messages + extraction pipeline (plural/gender; key conventions). Remaining: add automated message extraction; `apps/portal/scripts` only contains the accessibility audit tooling today.
- [ ] FE-03.8 — Pseudo-localization + missing-key detection (build/CI checks). Remaining: introduce pseudo-locale handling and CI guardrails; `apps/portal/src/i18n/index.tsx:92` exposes only `en`/`es`.
- [ ] FE-03.10 — Content/readability review (plain language; inclusive terms). Remaining: document review guidelines and outcomes; no localization section yet in `docs/CONVENTIONS.md`.
- [ ] FE-03.11 — Advanced a11y: forms, errors, live regions, focus/skip links. Remaining: add skip links and richer focus management beyond current alert handling (`apps/portal/src/App.tsx:9` has no skip-to-content entry point).
- [ ] FE-03.12 — High-contrast theme tokens and contrast audits (≥4.5:1). Remaining: expose a toggle and wire audits; `apps/portal/src/styles/tokens.css:22` defines tokens but no runtime switch.
- [ ] FE-03.13 — Zoom/reflow compliance (200% zoom; no content loss). Remaining: validate layouts under zoom and document results; no automated or manual log recorded.
- [ ] FE-03.14 — Media/alt text guidelines (icons/illustrations; captions if added). Remaining: author guidance doc and link from engineering docs.
- [ ] FE-03.16 — Performance: lazy-load locale bundles; code-split translations. Remaining: switch to dynamic imports; `apps/portal/src/i18n/index.tsx:3` statically imports all message bundles.
- [ ] FE-03.17 — Interpreter preferences: UI/validation/persistence (privacy-safe). Remaining: persist selections into the submission payload and honor `collect_patient_prefs`; current submit flow sends only `formData` (`apps/portal/src/components/IntakeForm.tsx:147` + `apps/portal/src/components/IntakeForm.tsx:312`).
- [ ] FE-03.18 — Fallback logic & offline locale cache (graceful degradation). Remaining: add offline caching for locale resources and fallback behaviour when storage/navigator checks fail.
- [ ] FE-03.19 — A11y/i18n QA matrix (SR combos, devices, browsers) & test plan. Remaining: capture the matrix in `docs/USAGE.md`.
- [ ] FE-03.20 — Localization authoring guide (glossary, style, review process). Remaining: add the guide to `docs/CONVENTIONS.md` and reference it from portal docs.
