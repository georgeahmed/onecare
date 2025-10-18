Engineer: Frontend 04

Role: Clinician Dashboard — Shell & Queue (Multi‑Clinic)
Stack: Web, TypeScript, React

Responsibilities
- Set up the clinician dashboard application shell, routing, auth/RBAC, multi‑clinic switcher, and the triage queue with filters and accessible list/table.

Start Here
- Architecture: docs/CONVENTIONS.md (state vs adapters, a11y/i18n), docs/ERRORS.md (envelopes)
- Contracts: docs/EVENTS.md (triage input/decision), packages/events
- Patient Portal patterns to reuse: apps/portal/src/components/booking/SearchSlots.tsx (a11y list patterns), apps/portal/src/i18n

Status: planned
Progress: 0%

Dependencies
- backend/orchestrator (queue/triage query endpoints)
- frontend/engineer-06 (A11y/Design System)

Platform Checklist (pre-flight)
- Multi‑tenant routing + RBAC; clinic scoping proven
- i18n ready; high‑contrast; keyboard navigation
- No PHI in logs; minimum necessary data on screen; audit-friendly correlation IDs visible

Tasks
- [ ] FE-04.1 — Scaffold app (apps/clinician) + Vite + TS project references
- [ ] FE-04.2 — Auth guard, RBAC roles (clinician, coordinator, admin) + clinic switcher
- [ ] FE-04.3 — Queue screen: filters (Clinic, Priority, Status, Mine/Unassigned, Time), traffic‑light + label, accessible list
- [ ] FE-04.4 — Data adapters: MockQueue in dev + API gateway interface for future backend endpoints
- [ ] FE-04.5 — URL state for filters/sorting; copyable deep links
- [ ] FE-04.6 — Virtualized list + empty/loading/error states
- [ ] FE-04.7 — Assign/Unassign row actions with optimistic update & rollback
- [ ] FE-04.8 — Unit tests for filters, list a11y, and adapter contracts; i18n keys added

