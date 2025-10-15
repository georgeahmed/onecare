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


- [x] FE-03.6 — RTL & bidirectional text support (dir, CSS logical props, bidi isolation)  
  Evidence: `apps/portal/src/i18n/index.tsx:136` computes locale directions and applies them to the document; `apps/portal/src/components/LocaleSwitcher.tsx:23` renders options with explicit `dir` metadata; `apps/portal/src/styles/global.css:332` swaps physical alignment for logical properties so slot cards respect RTL layouts.

- [x] FE-03.7 — ICU messages + extraction pipeline (plural/gender; key conventions)  
  Evidence: `apps/portal/scripts/i18n/extract.ts:8` exports locale bundles and enforces key parity; `.github/workflows/ci.yml:42` adds the extraction check to CI; `package.json:15` exposes `i18n:portal` commands for local authors.

- [x] FE-03.8 — Pseudo-localization + missing-key detection (build/CI checks)  
  Evidence: `apps/portal/src/i18n/pseudo.ts:1` generates pseudo-localized strings; `apps/portal/src/i18n/index.tsx:111` loads the pseudo locale on demand; `apps/portal/locales/pseudo.json` is generated alongside real locales for quick QA.

- [x] FE-03.16 — Performance: lazy-load locale bundles; code-split translations  
  Evidence: `apps/portal/src/i18n/index.tsx:111` dynamically imports non-default locales; `apps/portal/src/i18n/index.tsx:138` caches loaded bundles in-memory and in localStorage to avoid repeat fetches.

- [x] FE-03.17 — Interpreter preferences: UI/validation/persistence (privacy-safe)  
  Evidence: `schemas/ingest/portal-submission.json:58` defines the contract for interpreter preferences; `apps/portal/src/components/IntakeForm.tsx:159` sanitizes and submits the interpreter payload while persisting (with consent); `apps/portal/src/lib/interpreterPreferencesStorage.ts:1` encapsulates the local storage guardrails; `apps/portal/src/components/InterpreterPreferences.tsx:18` supports multi-select, notes, and “remember” consent.

- [x] FE-03.18 — Fallback logic & offline locale cache (graceful degradation)  
  Evidence: `apps/portal/src/i18n/index.tsx:138` reads/writes locale bundles through the offline cache before hitting the network; `apps/portal/src/hooks/useZoomFallback.ts:18` toggles responsive fallbacks at high zoom; `apps/portal/src/styles/global.css:216` stacks header/navigation when the zoom guard trips.

- [x] FE-03.13 — Zoom/reflow compliance (200% zoom; no content loss)  
  Evidence: `apps/portal/src/hooks/useZoomFallback.ts:18` stamps high-zoom state for runtime fallbacks; `apps/portal/src/styles/global.css:216` restructures header/nav under the zoom trigger; `docs/USAGE.md:53` adds the keyboard + 200 % zoom QA scenario.

- [x] FE-03.19 — A11y/i18n QA matrix (SR combos, devices, browsers) & test plan  
  Evidence: `docs/USAGE.md:41` adds the combined localization & accessibility QA matrix plus execution checklist.

- [x] FE-03.20 — Localization authoring guide (glossary, style, review process)  
  Evidence: `docs/CONVENTIONS.md:16` documents glossary, writing style, key conventions, and review workflow for new strings.


Status: planned
Progress: 0%