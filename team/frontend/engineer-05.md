Engineer: Frontend 05

Role: Clinician Dashboard — Case View & Actions
Stack: Web, TypeScript, React

Responsibilities
- Build the case detail view (patient narrative, interpreter badge, attachments), action bar (Call, Schedule, Book, Escalate, Resolve), notes/outcome, and audit timeline. Integrate the scheduling mini‑panel and conflict handling.

Start Here
- Reuse: apps/portal/src/components/booking/BookingErrorView.tsx (conflict UX), apps/portal/src/components/booking/SearchSlots.tsx (date/time i18n)
- Contracts & errors: docs/ERRORS.md, packages/events

Status: planned
Progress: 0%

Dependencies
- frontend/engineer-04 (queue navigation/routing)
- booking service (confirm/availability endpoints), orchestrator (audit)
- frontend/engineer-06 (A11y/Design System)

Platform Checklist (pre-flight)
- Keyboard‑first flow; visible focus; ARIA for action regions
- Minimum necessary PHI; correlation ID surfaced; attachments open securely

Tasks
- [ ] FE-05.1 — Case header (priority, wait time, clinic, correlation ID)
- [ ] FE-05.2 — Narrative, interpreter/language badge; attachments list with safe open
- [ ] FE-05.3 — Action bar: Call now, Schedule, Book slot, Escalate, Resolve
- [ ] FE-05.4 — Scheduling mini‑panel: quick picks + exact slot; conflict suggestions (+/‑30m, +60m)
- [ ] FE-05.5 — Notes box + outcome picker; optimistic save with rollback
- [ ] FE-05.6 — Audit timeline (who/when/what); link to correlation reference
- [ ] FE-05.7 — Error/empty/loading states, confirmation dialogs for irreversible actions
- [ ] FE-05.8 — Unit tests for actions, conflict handling, and audit rendering; i18n keys added

