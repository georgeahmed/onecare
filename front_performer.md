# ONECARE Pilot Walkthrough

Use this guide when you want to run a live demo or acceptance session of the ONECARE platform on your laptop. Every step is written for a non-programmer: copy the commands exactly, watch for the expected screen, and use the callouts if something behaves differently.

> **Safety reminder:** All sample IDs and tokens are demo-only. Never paste real patient information into this environment.

---

## Before You Start

- Laptop needs Docker Desktop, Node.js (v20), npm (v9), and at least 15 GB free disk space.
- Close other demos that might already be using ports 3000–4002.
- Open a terminal window (macOS: Terminal app).

---

## Step 1. Launch the Core Services

1. In the terminal, run:
   ```bash
   cd /Users/test/Code/onecare/onecare
   make docker-up
   ```
2. Wait until every service shows `healthy` or `running`. You can check with:
   ```bash
   docker-compose ps
   ```
3. Confirm the main API (Orchestrator) is ready:
   ```bash
   curl -s http://localhost:3001/readyz | jq
   ```
   You should see `{"status":"ok"}`.

If a service refuses to start, restart Docker Desktop and try `make docker-up` again.

---

## Step 2. Open the Patient Portal

1. In a second terminal window:
   ```bash
   cd /Users/test/Code/onecare/onecare/apps/portal
   npm install           # only the first time
   VITE_ORCH_URL=http://localhost:3001 npm run dev
   ```
2. After a few seconds, the command will say the portal is available at `http://localhost:5173`.
3. Open that address in your browser.

**What you should see**
- Landing screen for Demo Practice with a form labelled *Tell us how you’re feeling*.
- Language switcher in the top right (English, Español, Pseudo).

If the page never loads, clear the browser cache (Chrome → Application → Service Workers → Unregister) and refresh.

---

## Step 3. Complete the Patient Intake Scenario

Use the built-in demo credentials:
- Practice ID: `demo` (type the ID without spaces; the label “Demo Practice” may appear, but the field expects the ID `demo`)
- Patient ID: `demo-patient` (or any “demo-*” string)

**Action**
1. Enter a short narrative, for example “I have chest pain when I walk.”
2. Click **Submit**.

**Expected result**
- A guidance card appears:
  - **Red** card means escalate immediately.
  - **Amber** card means contact soon with self-care tips.
  - **Green** card means safe to watch and wait.
- A reference code (correlation ID) appears near the bottom. Record this if you are logging the outcome.

If the screen shows an error:
- `Try again` messages usually mean the backend is still starting. Wait 10 seconds and submit again.
- If you get “Something went wrong,” check the terminal that’s running `npm run dev` for details.

---

## Step 4. Optional – Test Booking from the Patient Portal

Booking slots require the helper stack (`npm run dev:all`). Use this when you want to show an end-to-end intake → booking flow.

1. In a third terminal:
   ```bash
   cd /Users/test/Code/onecare/onecare
   export FHIR_BASE_URL="https://hapi.fhir.org/baseR4"
   npm run dev:all
   ```
   This starts:
   - Signing proxy on `http://localhost:4000`
   - Booking stub on `http://localhost:4002`
   - Portal dev server (if not already running)
2. Refresh the patient portal. After submitting a green/amber scenario you’ll see a “Find an appointment” button.
3. Search for slots and confirm one. The confirmation panel shows a booking reference and idempotency key.

If no slots appear, make sure the helper stack is still running and visit `http://localhost:4002/health` to double-check the stub.

---

## Step 5. Launch the Clinician Console

1. In another terminal window:
   ```bash
   cd /Users/test/Code/onecare/onecare/apps/clinician
   npm install                             # first time only
   npm run dev -- --port 5174
   ```
2. Open `http://localhost:5174` in the browser.

**What you should see**
- Banner showing **Jamie Clinician** with clinics **Demo Practice** and **Northside Clinic**.
- A queue table listing demo tasks (`t-001 Chest pain`, `t-002 High fever`, etc.).

If the queue is empty, clear the browser’s site data and refresh; the app stores demo tasks in `localStorage`.

---

## Step 6. Work the Clinician Queue

Run through the following actions to simulate daily operations. The mock data behaves like a live feed, so you can repeat the steps as needed.

1. **Assign a task**
   - In the queue, choose **t-001 Chest pain**.
   - Click **Take ownership**.
   - The status changes to *In progress* and your name appears as the assignee.

2. **Schedule a callback**
   - Under *Follow-up*, pick **Schedule callback**.
   - Choose a time in the future (for example tomorrow at 09:00).
   - Save. The timeline shows the scheduled slot.

3. **Record an assisted booking (optional)**
   - Click **Assist booking**.
   - Request recommendations (requires the helper stack from Step 4).
   - Select **Booked** and confirm.
   - If the booking proxy is active, the backend logs a `/booking/assisted` event; otherwise the mock will still mark the task as booked.

4. **Resolve the case**
   - Choose an outcome (e.g., “Patient called and reassured”) and click **Resolve case**.
   - The queue removes the item from the active list.

Switch to **Northside Clinic** from the header to review additional sample tasks, including one already assigned to someone else (good for demonstrating conflict handling).

---

## Step 7. Spot-Check System Health (Optional)

These checks help you confirm everything is still running if the UI stalls.

- Orchestrator: `curl http://localhost:3001/readyz`
- Safety Gate (Python triage): visit `http://localhost:8081/docs`
- Message bus (NATS): `http://localhost:8222` (user `onecare`, pass `onecare-secret`)
- Logs dashboard (Grafana): `http://localhost:3000` (default login admin/admin)

---

## Step 8. Shut Everything Down

1. Stop each dev server by pressing `Ctrl+C` in its terminal window.
2. Return to the main repo directory and run:
   ```bash
   cd /Users/test/Code/onecare/onecare
   make docker-down
   ```
3. If you also ran the helper stack, stop it with:
   ```bash
   npm run dev:all:stop
   ```

Now the environment is clean for the next session.

---

## Quick Reference – Demo Headers & IDs

Use these values when an API call requires manual headers (for example, running the curl sample below):

| Header/Field        | Value                |
|---------------------|----------------------|
| Practice ID         | `demo`               |
| Authorization       | `Bearer dev-token`   |
| x-actor-type        | `patient`            |
| x-actor-id          | `demo-patient`       |
| x-auth-scope        | `submit triage:submit` |
| x-request-id        | any UUID (e.g., `demo-request-001`) |

Example API test:
```bash
curl -s -X POST http://localhost:3001/safety-check \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-token' \
  -H 'x-actor-type: patient' \
  -H 'x-actor-id: demo-patient' \
  -H 'x-auth-scope: submit triage:submit' \
  -H 'x-request-id: pilot-check-001' \
  -d '{"practiceId":"demo","patient":{"id":"demo-patient"},"narrative":"Shortness of breath climbing stairs","channel":"web"}' | jq
```

---

## Troubleshooting Cheatsheet

- **Portal stuck on loading:** Clear Service Worker cache (Chrome DevTools → Application → Service Workers → Unregister) and refresh.
- **Clinician queue blank:** Clear browser storage for `localhost:5174`, refresh to reload the demo tasks.
- **Repeated “Try again later” messages:** Wait 10 seconds; if it persists, restart `make docker-up`.
- **Docker refuses to start:** Run `docker system prune` (if safe) or reboot Docker Desktop.
- **Need a fresh start:** After shutting down, remove containers with `docker-compose down -v` to clear cached data.

---

Keep this guide with your pilot script. If you change patient flows, booking behavior, or clinician actions, update the relevant step here so future pilots stay in sync. For technical escalations, contact the platform engineering team and share the correlation ID shown in the UI.
