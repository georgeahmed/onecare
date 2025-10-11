AGENTS.md — Booking

Scope
- Applies to `apps/booking/*`.

Invariants
- Respect eligibility; prefer GP Connect for federated bookings; write-back Appointment to FHIR.

Do
- Handle conflict/retry on appointment create; surface clear errors.
- Keep Search → Selected → Booked → WrittenBack → Confirmed flow atomic from user POV.

Don’t
- Don’t book without eligibility check and consent.

Checklist
- [ ] Search filters + paging; safe defaults
- [ ] Idempotency for create; conflict handling
- [ ] Confirmation to patient and write-back
- [ ] Unit tests for booking + conflict path

