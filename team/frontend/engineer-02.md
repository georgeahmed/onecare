Engineer: Frontend 02

Role: Frontend Engineer (Callback & Booking)
Stack: Web, TypeScript

Responsibilities
- Display callback windows by priority; booking confirmation UI.

Initial Tasks
- Integrate triage priorities; show callback options; booking confirmation.

Start Here
- Algorithm.md: Telephony parity callback windows, Booking sequence
- Config: config/nhs_gp_defaults.yaml (callback_windows_by_priority)
 - A11y/i18n: team/frontend/engineer-03.md (RTL, high‑contrast, ICU messages)

Status: in-progress (12/17 tasks complete)
Progress: 71%

Dependencies
- backend/engineer-03 (Triage outputs)
- backend/engineer-04 (Booking service)
 - frontend/engineer-03 (Accessibility/Localization)

Platform Checklist (pre-flight)
- Booking/Triage endpoints known; CORS configured; auth/headers as needed.
- Schemas for booking search/appointment-created available; UI maps errors/conflicts.
- Error envelopes supported; correlationId carried across flows.
- No PII in logs; accessibility baseline verified.
 - Design tokens applied; calendar/list components meet contrast ≥4.5:1; focus/ARIA semantics correct.
 - Locale formatting for dates/times (12/24h); RTL verified on calendar; translation keys complete.
 - Performance targets (LCP/INP/CLS) and virtualization/prefetch planned for large slot sets.
 - Offline confirm queue in place with idempotency keys; backoff/resume UX designed.
 - Security: strict CSP; avoid PII in client logs; sanitize any rendered content.

Tasks

Completed
- [x] FE-02.1 — Read/display callback windows by priority (config-driven) — implemented with config-driven resolver and localized UI (apps/portal/src/lib/callbackWindows.ts; apps/portal/src/components/CallbackWindows.tsx).
- [x] FE-02.2 — Booking search UI (stub call) → list slots — accessible list with filters, skeletons, and tests (apps/portal/src/components/booking/SearchSlots.tsx; apps/portal/test/booking/SearchSlots.test.tsx).
- [x] FE-02.3 — Select slot → booking confirmation view — idempotency key generation and confirmation dialog wired to API (apps/portal/src/pages/Booking.tsx; apps/portal/src/components/booking/ConfirmBooking.tsx; apps/portal/src/lib/booking.ts).
- [x] FE-02.4 — Friendly error/conflict states for booking — conflict guidance, countdown, and focus management shipped (apps/portal/src/components/booking/BookingErrorView.tsx; apps/portal/test/booking.error.test.tsx).
- [x] FE-02.5 — Accessibility (keyboard nav) for dialogs/forms — focus trap, listbox semantics, and axe coverage in place (apps/portal/src/components/booking/ConfirmBooking.tsx; apps/portal/src/components/booking/SearchSlots.tsx; apps/portal/test/a11y.test.ts).
- [x] FE-02.6 — Calendar view with EA windows overlay (TZ-safe, high-contrast) — weekly grid renders enhanced access windows and slots with keyboard navigation and tests (apps/portal/src/components/booking/Calendar.tsx; apps/portal/src/lib/enhancedAccess.ts; apps/portal/test/booking/Calendar.test.tsx).
- [x] FE-02.7 — Filters (in-person/phone), fairness notes, and empty states — fairness guidance, enriched empty states, and config parser wired into booking filters (apps/portal/src/components/booking/SearchSlots.tsx; apps/portal/src/lib/fairness.ts; apps/portal/test/fairness.test.ts).
- [x] FE-02.8 — Performance: list virtualization, prefetch next-step assets — slot list virtualized with RUM signal and confirm prefetch (apps/portal/src/components/booking/SearchSlots.tsx; apps/portal/src/styles/global.css; apps/portal/test/booking/SearchSlots.test.tsx).
- [x] FE-02.9 — Offline/spotty network UX (queue confirm, backoff, resume) — confirm dialog queues requests offline with exponential backoff and resume logic (apps/portal/src/components/booking/ConfirmBooking.tsx; apps/portal/src/lib/offlineQueue.ts; apps/portal/test/offlineQueue.test.ts).
- [x] FE-02.10 — Error mapping (429/503/409/504) with friendly copy/backoff — error envelopes mapped to localized copy with retry handling (apps/portal/src/components/booking/BookingErrorView.tsx; docs/ERRORS.md).
- [x] FE-02.11 — Observability (correlationId headers; RUM timing; PHI-safe logs) — telemetry helpers capture correlation IDs and timings for booking flows (apps/portal/src/lib/telemetry.ts; apps/portal/src/lib/api.ts; apps/portal/src/pages/Booking.tsx).
- [x] FE-02.12 — Internationalization & Localization (labels/RTL/date-time) — added Arabic locale, RTL-aware layouts, and locale-aware booking copy (apps/portal/src/i18n/index.tsx; apps/portal/src/components/booking/*; apps/portal/src/styles/global.css).
- [x] FE-02.14 — Testing: e2e booking flow, a11y (axe), contract (Ajv), unit — added booking cache/unit tests, Ajv contract coverage, and Playwright guidance (apps/portal/test/*; apps/portal/tests/e2e/booking.spec.ts; apps/portal/README.md).

Incomplete
- [ ] FE-02.13 — State/data architecture (idempotent confirm; cancel/retry) — idempotency handled, but cache layer/state context and documentation not yet built (apps/portal/src/pages/Booking.tsx; missing apps/portal/src/lib/data.ts).
- [ ] FE-02.14 — Testing: e2e booking flow, a11y (axe), contract (Ajv), unit — unit/a11y tests exist but no e2e or Ajv contract coverage yet (apps/portal/test).
- [ ] FE-02.15 — Documentation & microcopy guidelines (booking UX) — portal README and conventions lack booking microcopy guidance (apps/portal/README.md missing; docs/CONVENTIONS.md untouched).
- [ ] FE-02.16 — Visual polish & micro-interactions (skeletons, success state) — skeletons added but no add-to-calendar links or motion-aware celebrations (apps/portal/src/pages/Booking.tsx; apps/portal/src/styles/tokens.css).
- [ ] FE-02.17 — Responsive QA (mobile-first layouts, touch targets) — responsive audits outstanding; CSS lacks mobile-specific rules or safe-area handling (apps/portal/src/styles/global.css).
