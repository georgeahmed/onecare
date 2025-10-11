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

Status: planned
Progress: 0%

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
- [ ] FE-02.1 — Read/display callback windows by priority (config-driven)
- [ ] FE-02.2 — Booking search UI (stub call) → list slots
- [ ] FE-02.3 — Select slot → booking confirmation view
- [ ] FE-02.4 — Friendly error/conflict states for booking
- [ ] FE-02.5 — Accessibility (keyboard nav) for dialogs/forms
 - [ ] FE-02.6 — Calendar view with EA windows overlay (TZ-safe, high-contrast)
 - [ ] FE-02.7 — Filters (in-person/phone), fairness notes, and empty states
 - [ ] FE-02.8 — Performance: list virtualization, prefetch next-step assets
 - [ ] FE-02.9 — Offline/spotty network UX (queue confirm, backoff, resume)
 - [ ] FE-02.10 — Error mapping (429/503/409/504) with friendly copy/backoff
 - [ ] FE-02.11 — Observability (correlationId headers; RUM timing; PHI-safe logs)
 - [ ] FE-02.12 — Internationalization & Localization (labels/RTL/date-time)
 - [ ] FE-02.13 — State/data architecture (idempotent confirm; cancel/retry)
 - [ ] FE-02.14 — Testing: e2e booking flow, a11y (axe), contract (Ajv), unit
 - [ ] FE-02.15 — Documentation & microcopy guidelines (booking UX)
 - [ ] FE-02.16 — Visual polish & micro-interactions (skeletons, success state)
 - [ ] FE-02.17 — Responsive QA (mobile-first layouts, touch targets)
