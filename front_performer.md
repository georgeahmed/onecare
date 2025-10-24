# Front Performer Runbook

This runbook helps front-line coordinators operate the ONECARE platform locally for demos, manual testing, or support triage. Follow it alongside the core engineering guardrails in `AGENTS.md` and never copy real patient data into the system.

## 1. Launch the Docker Stack

1. Open a terminal and run:
   ```bash
   cd /Users/test/Code/onecare/onecare && make docker-up
   ```
   This composes NATS, Safety Gate, Scribe, Orchestrator, analytics, and observability services.
2. Watch container health:
   - `docker-compose ps` shows when everything is healthy (look for `healthy` or `running` state).
   - `docker logs -f orchestrator` and `docker logs -f safety-gate` stream backend activity.
3. Verify readiness:
   - Orchestrator HTTP probe: `curl -s http://localhost:3001/readyz | jq`
   - Safety Gate OpenAPI: `http://localhost:8081/docs`
   - OTEL collector health: `curl -s http://localhost:13133/healthz`
4. When finished, stop everything with `make docker-down`. Always shut down the stack when not in use to avoid stale state.

## 2. Start the Patient Portal

The portal is not included in `docker-up`. Run it from a separate terminal:

```bash
cd /Users/test/Code/onecare/onecare/apps/portal
npm install           # first time only
VITE_ORCH_URL=http://localhost:3001 npm run dev
```

The Vite dev server listens on `http://localhost:5173`. Sign-in is form-less in demo mode; submitting the intake flow issues API calls directly to the orchestrator (`/safety-check`, `/booking/*`) using the headers below. Keep the terminal open so hot reload and network errors remain visible.

### Portal Expectations
- **Home / Intake:** collects practice selection, symptoms, and callback preferences. Expect Safety Gate responses to render as guidance cards (green for ok, amber for watchful waiting, red for escalate).
- **Booking flow:** when `demo` practice has availability stubs enabled via docker stack, the “Find an appointment” step shows sample slots. Failing upstream checks surfaces a `rate_limited` or `over_capacity` UI banner.
- **Error surfaces:** network issues show retry hints, but persistent 4xx errors redirect to support content. Record the correlation ID from the toast or developer tools when escalating.

## 3. Start the Clinician Console

The clinician console gives coordinators and clinicians visibility into the shared triage queue. Run it alongside the patient portal.

```bash
cd /Users/test/Code/onecare/onecare/apps/clinician
npm install                                      # first time only
npm run dev -- --port 5174                       # mock queue + dev session
# Optional: wire assisted bookings to the proxy/booking stub
# VITE_BOOKING_API_URL=http://localhost:4000 npm run dev -- --port 5174
```

The dev server listens on `http://localhost:5174` (Vite auto-increments if 5174 is in use). In development, the console seeds a session for **Jamie Clinician** (`clinician-dev`) with access to the `demo` and `north` practices (`apps/clinician/src/lib/auth.tsx`). Switch clinics from the header dropdown to preview different queues.

### Console Expectations
- **Queue view:** Lists triage tasks grouped by priority, waiting time, interpreter needs, and assignment status. Use dropdown filters (priority, status, ownership, elapsed time) to mirror daily routing.
- **Task details:** Selecting a row opens the case panel with the original narrative, attachments, audit trail, and action buttons (call, schedule callback, escalate, resolve).
- **Assisted booking modal:** `Assist booking` surfaces recommended slots (mocked locally unless `VITE_BOOKING_API_URL` points to the booking proxy). Submitting `Booked` or `No time` updates the queue and, when configured, posts to `/booking/assisted`.
- **Session storage:** State persists in `localStorage` (`onecare.clinician.*`). Use the browser dev tools to clear it when you want to reset the mock session.

To connect the console to real queue data, configure the queue gateway:
- `VITE_QUEUE_GATEWAY=assisted` and `VITE_BOOKING_API_URL=http://localhost:3001` (or proxy URL) routes assisted actions to the booking service while still reading queue items from the mock seed.
- A full end-to-end feed requires the analytics service to publish `clinician.task.*` events and the queue API to expose them; coordinate with the backend team before relying on live data for pilots.

## 4. Sample Credentials & Headers (Local Only)

| Purpose | Value |
| --- | --- |
| Practice | `demo` |
| Authorization | `Authorization: Bearer dev-token` |
| Actor type | `x-actor-type: patient` |
| Actor id | `x-actor-id: demo-patient` |
| Scope | `x-auth-scope: submit triage:submit` |
| Correlation | `x-request-id: demo-request-001` (any UUID) |

These are published demo defaults. Do **not** reuse in shared environments. For staging/production, fetch real credentials from the secret manager and update the hashicorp-vault-backed `.env` entries instead of hard-coding them here.

## 5. End-to-End Scenarios

### Scenario A — Symptom Intake (Portal → Orchestrator → Safety Gate)
1. Launch docker stack and portal as above.
2. In the portal, choose practice **Demo Practice** and submit a symptom narrative (e.g., “mild headache for 2 days”).
3. Expected backend activity:
   - Portal calls `POST http://localhost:3001/safety-check` with headers listed earlier.
   - Orchestrator validates schema, forwards the payload to Safety Gate at `http://localhost:8081/triage`.
   - Safety Gate responds with a triage decision (`green`, `amber`, or `red`). The orchestrator wraps it in the error envelope on failure, or forwards guidance on success.
4. Validate in logs:
   - `docker logs -f orchestrator` shows `metric.http.request` entries with status and correlation ID.
   - `docker logs -f safety-gate` confirms request receipt and ML stub decision.
5. Result in portal: UI surfaces care recommendation, timestamp, and the correlation ID.

### Scenario B — Manual API Smoke (CLI)
Use this when you want to sanity-check the backend without the portal.

```bash
curl -s -X POST http://localhost:3001/safety-check \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-token' \
  -H 'x-actor-type: patient' \
  -H 'x-actor-id: demo-patient' \
  -H 'x-auth-scope: submit triage:submit' \
  -H 'x-request-id: demo-cli-001' \
  -d '{"practiceId":"demo","patient":{"id":"demo-patient"},"narrative":"I have chest pain","channel":"web"}' | jq
```

Expected output is a triage response with `decision`, `guidance`, and `correlationId`. Non-200 responses follow the structured error envelope in `docs/ERRORS.md`.

### Scenario C — Booking Availability (Optional Stub)
The default docker stack does not ship a booking stub. To demonstrate slot search and confirmation, run the helper stack in another terminal:

```bash
cd /Users/test/Code/onecare/onecare
export FHIR_BASE_URL="https://hapi.fhir.org/baseR4"   # or your sandbox URL
npm run dev:all
```

This starts:
- Portal signing proxy on `http://localhost:4000`
- Booking stub on `http://localhost:4002`
- Orchestrator (memory bus) on `http://localhost:3001`
- Safety Gate on `http://localhost:8081`

With both docker (for analytics/observability) and the helper stack running:
1. In the portal, proceed to booking after a green triage outcome.
2. Expected behavior:
   - Portal queries orchestrator `/booking/search`; the helper proxy fans out to the stub (`http://localhost:4002/slots`) and streams sample slots back.
- Selecting a slot issues `/booking/appointments` and returns a confirmation payload with `appointmentId` and `idempotencyKey`.
3. Inspect responses via browser dev tools or `docker logs -f orchestrator`.
4. If no slots appear, confirm the stub is reachable with `curl http://localhost:4002/health` and check the proxy output in `.dev-all/helpers/portal-proxy.log`. Set `FHIR_TOKEN` / `FHIR_AUTH_TOKEN` if your sandbox endpoint requires authentication.

### Scenario D — Clinician Queue Triage (Mock Seed)
1. Ensure the docker stack, patient portal, and clinician console are running. For assisted bookings, also start `npm run dev:all` so the proxy (`:4000`) and booking stub (`:4002`) are available.
2. Open `http://localhost:5174`, confirm the banner shows “Jamie Clinician,” and select the **Demo Practice** queue.
3. Expected queue contents:
   - `t-001` — STAT, interpreter Urdu, waiting ~15 minutes (chest pain).
   - `t-002` — URGENT, waiting ~40 minutes (high fever).
   - `t-003` — ROUTINE medication query, waiting ~2 hours.
   - Additional tasks appear when switching to **Northside Clinic** (e.g., `t-004` already assigned, `t-005` unassigned).
4. Actions to exercise:
   - **Assign to self:** Choose `t-001`, click *Take ownership* (updates status to `IN_PROGRESS`, audit trail logs the assignment).
   - **Schedule callback:** In the case view, pick *Schedule callback*, fill a future time, and save. The task status changes and the callback window appears in the audit list.
   - **Assisted booking:** Open *Assist booking*, request recommended slots (requires booking stub/proxy). Select a slot and mark the outcome as `Booked`. Verify `docker logs -f orchestrator` (or proxy logs under `.dev-all/helpers/portal-proxy.log`) for the `/booking/assisted` call when `VITE_BOOKING_API_URL` is set.
   - **Resolve or escalate:** Use the action bar to close the case or escalate; announcements appear in the live region at the bottom of the case view.
5. Troubleshooting: If the queue fails to load, confirm the browser console shows `MockQueueGateway` responses. Clearing `localStorage` resets the seed; to remove mock data entirely, set `VITE_QUEUE_GATEWAY=assisted` and point the app at the real queue API.

## 6. Backend Observability Checklist

- **Readiness:** `curl http://localhost:3001/readyz` (orchestrator), `curl http://localhost:8081/healthz` (Safety Gate, Python FastAPI default), `curl http://localhost:8082/healthz` (Scribe).
- **Metrics:** Loki and Promtail ship logs; connect Grafana at `http://localhost:3000` (default login admin/admin, change on first use).
- **Events:** NATS JetStream UI is at `http://localhost:8222`. Default local credentials match docker-compose (`user: onecare`, `pass: onecare-secret`). These are demo-only and must be rotated in higher environments.
- **Tracing:** OTLP collector listens on 4317/4318; point your local Jaeger or Tempo instance to those endpoints if you want live traces.

## 7. Handling Credentials Safely

- Store secrets outside the repo (`.env.local` added to `.gitignore`) and load them with `direnv` or `dotenvx`.
- Rotate demo tokens monthly even for local use; update the `docs/USAGE.md` snippet if values change.
- Never screenshot PHI or tokens. When capturing walkthroughs, anonymize with lorem ipsum data.
- When working with real environments, request time-bound tokens from the platform team and confirm scope in `docs/SECURITY_AUTHZ.md`.

## 8. Troubleshooting Tips

- **Portal cannot connect:** Ensure Vite env var `VITE_ORCH_URL` points to `http://localhost:3001`. Clear Service Worker cache (Chrome DevTools → Application → Service Workers → Unregister).
- **403 Forbidden:** Check the `authorization` and `x-auth-scope` headers. Safety Gate rejects missing scopes.
- **504 Timeout:** Safety Gate dependency offline. Restart docker stack or run `docker logs safety-gate` for stack traces.
- **Duplicate submissions:** Correlation/Idempotency keys must be unique per request. Regenerate `x-request-id` if re-testing.
- **Docker fails to start:** Run `docker system prune` (with caution) or reboot Docker Desktop, then retry `make docker-up`.

## 9. Clean-Up

1. Stop portal dev server (`Ctrl+C` in the terminal).
2. Tear down backend: `cd /Users/test/Code/onecare/onecare && make docker-down`.
3. Optionally clear volumes if you want a fresh dataset: `docker-compose down -v` (only after confirming nothing else depends on the data).

Keep this runbook updated when endpoints, ports, or required headers change. Submit PRs with small, focused updates and cross-link any new automation or scripts in `docs/USAGE.md`.
