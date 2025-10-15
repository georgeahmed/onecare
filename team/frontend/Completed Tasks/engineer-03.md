Engineer: Frontend 03 — Completed Tasks

- [x] FE-03.1 — i18n library setup + locale switcher  
  Evidence: `apps/portal/src/App.tsx:9` wraps the UI in `I18nProvider`; `apps/portal/src/i18n/index.tsx:61` persists locale selection and applies it to the document; `apps/portal/src/components/LocaleSwitcher.tsx:18` renders the locale switcher with translated labels; `apps/portal/src/components/LocaleSwitcher.test.tsx:10` guards the label association.

- [x] FE-03.2 — Language preference capture (patient.locale) in submission  
  Evidence: `apps/portal/src/features/schemaForm/fieldMap.ts:41` exposes a localized select for `patient.locale`; `apps/portal/src/components/IntakeForm.tsx:151` syncs the active locale into form state and request headers; `schemas/ingest/portal-submission.json:23` allows the locale on the contract; `apps/portal/test/sanitizeSubmission.test.ts:58` verifies trimming and validation.

- [x] FE-03.3 — Accessibility baseline (focus, contrast) + fixes  
  Evidence: `apps/portal/src/styles/global.css:52` implements consistent focus outlines and accessible color usage; `apps/portal/src/styles/tokens.css:1` defines contrast-safe tokens with a high-contrast palette; `apps/portal/src/components/ErrorAlert.tsx:69` focuses alerts and announces them via `aria-live`.

- [x] FE-03.4 — Interpreter preferences UI section (config-driven)  
  Evidence: `apps/portal/src/hooks/useAccessibilityConfig.ts:5` reads accessibility defaults; `apps/portal/src/components/IntakeForm.tsx:170` toggles the interpreter section based on config; `apps/portal/src/components/InterpreterPreferences.tsx:18` renders configurable language, notes, and BSL confirmation fields; `apps/portal/test/interpreterPreferences.test.tsx:8` covers the conditional rendering.

- [x] FE-03.5 — Accessibility audit tooling in CI  
  Evidence: `apps/portal/scripts/a11y-ci.ts:1` runs pa11y against intake and booking routes; `.github/workflows/ci.yml:49` executes `npm run a11y:portal` in the main pipeline to fail on critical accessibility regressions.

- [x] FE-03.9 — Locale date/number/timezone formatting (12/24h; week start)  
  Evidence: `apps/portal/src/components/booking/SearchSlots.tsx:15` localizes date/time labels via `Intl.DateTimeFormat`; `apps/portal/src/components/booking/BookingErrorView.tsx:25` formats conflict suggestions and filters for the current locale; `apps/portal/src/components/CallbackWindows.tsx:29` renders callback copy with translated labels.

- [x] FE-03.15 — Localized error/envelope mapping (docs/ERRORS.md)  
  Evidence: `apps/portal/src/components/ErrorAlert.tsx:7` maps error codes to translated titles/descriptions; `docs/ERRORS.md:21` documents how envelopes map to UI guidance for portal surfaces.


Status: planned
Progress: 0%