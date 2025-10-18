Clinician Dashboard API (Draft)

Purpose
- Provide minimal HTTP endpoints for the clinician dashboard to list, view, and act on patient requests (multi‑clinic), consistent with existing error envelopes and idempotency/correlation patterns.

Auth & Headers
- Auth: Bearer token (zero‑trust headers mirrored from Portal patterns where applicable)
- Correlation: `x-correlation-id` echoed on responses
- Idempotency (for mutating actions): `x-idempotency-key` (server may derive if missing)

Endpoints (proposed)
1) GET /clinician/tasks
   - Query: `clinicId` (required), optional `priority` (STAT|URGENT|SOON|ROUTINE), `status` (NEW|IN_PROGRESS|DONE), `assignee` (me|unassigned|any), `from`, `to`, `limit`, `cursor`
   - 200 → { items: TaskSummary[], nextCursor?: string }

2) GET /clinician/tasks/:id
   - 200 → TaskDetail

3) POST /clinician/tasks/:id/assign
   - Body: { assignee: string } (or implicit “me”)
   - 200 → TaskDetail

4) POST /clinician/tasks/:id/unassign
   - 200 → TaskDetail

5) POST /clinician/tasks/:id/resolve
   - Body: { outcome: string, note?: string }
   - 200 → TaskDetail

6) POST /clinician/tasks/:id/schedule-callback
   - Body: { when: string (ISO), window?: string, note?: string }
   - 200 → TaskDetail

7) POST /clinician/tasks/:id/book-slot
   - Body: { slotId: string, modality?: string, location?: string }
   - 200 → TaskDetail (with appointment reference)

Errors
- Error envelopes per docs/ERRORS.md; do not include stack traces. Preserve `x-correlation-id`.

Models (high‑level; JSON Schemas to follow)
- TaskSummary: { id, clinicId, priority, status, shortReason, patientId, waitMs, interpreter?: string, assignee?: string, createdAt }
- TaskDetail: TaskSummary + { narrative, attachments?: [{ contentType, url }], actionsAllowed: string[], audit: [{ when, who, what }], correlationId }

Notes
- Pagination via `limit` + `cursor` (opaque)
- Minimum necessary data only; no DOB or sensitive identifiers unless required by clinic policy
- Attachments served via short‑lived signed URLs

Next
- Add JSON Schemas under `schemas/clinician/` once backend team signs off; wire into codegen mappings.

