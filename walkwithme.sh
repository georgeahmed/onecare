#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(pwd)"
HELPER_DIR="${ROOT_DIR}/.walkwithme"

if [ ! -d "${HELPER_DIR}" ]; then
  mkdir -p "${HELPER_DIR}"
fi

RESET=""
BOLD=""
DIM=""
ITALIC=""
UNDERLINE=""
ACCENT=""
ACCENT_LIGHT=""
SUCCESS=""
WARN=""
INFO=""
CMD=""
HINT=""
PANEL=""
PANEL_EDGE=""
ICON_STEP="➤"
ICON_INFO="ℹ"
ICON_WARN="⚠"
ICON_DONE="✔"

if [ -t 1 ]; then
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  ITALIC=$'\033[3m'
  UNDERLINE=$'\033[4m'
  ACCENT=$'\033[38;5;39m'
  ACCENT_LIGHT=$'\033[38;5;123m'
  SUCCESS=$'\033[38;5;82m'
  WARN=$'\033[38;5;214m'
  INFO=$'\033[38;5;153m'
  CMD=$'\033[38;5;45m'
  HINT=$'\033[38;5;110m'
  PANEL=$'\033[48;5;236m\033[38;5;252m'
  PANEL_EDGE=$'\033[38;5;240m'
  ICON_STEP=$'🡆'
  ICON_INFO=$'ℹ'
  ICON_WARN=$'⚠'
  ICON_DONE=$'✔'
  trap 'printf "%s" "$RESET"' EXIT
fi

if [ ! -f "${ROOT_DIR}/package.json" ] || [ ! -d "${ROOT_DIR}/apps" ]; then
  cat <<EOF
${WARN}${BOLD}Heads up!${RESET}
This helper must run from the root of the ONECARE repository.
Please run ${CMD}cd /path/to/onecare${RESET} and launch this script again.
EOF
  exit 1
fi

STEP=1
TOTAL_STEPS=32

CONSENT_FIXTURE_PATH="${HELPER_DIR}/consent-fixture.json"
BOOKING_STUB_PATH="${HELPER_DIR}/booking-stub.js"
PORTAL_PROXY_PATH="${HELPER_DIR}/portal-proxy.js"
PLAYWRIGHT_CONFIG_PATH="${HELPER_DIR}/portal-playwright.local.config.ts"

helpers_created=()

record_helper() {
  helpers_created+=("$1")
}

ensure_consent_fixture() {
  if [ ! -f "${CONSENT_FIXTURE_PATH}" ]; then
    cat <<'EOF' > "${CONSENT_FIXTURE_PATH}"
{
  "patient-123": [
    {
      "purpose": "care",
      "resources": ["QuestionnaireResponse", "Communication", "Slot"],
      "reference": "Consent/patient-123-care",
      "grantedAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2030-01-01T00:00:00Z"
    },
    {
      "purpose": "analytics-lite",
      "resources": ["FeatureLog"],
      "reference": "Consent/patient-123-analytics",
      "grantedAt": "2024-01-01T00:00:00Z"
    }
  ],
  "patient-42": [
    {
      "purpose": "care",
      "resources": ["QuestionnaireResponse", "Communication", "Slot"],
      "reference": "Consent/patient-42-care",
      "grantedAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2030-01-01T00:00:00Z"
    }
  ],
  "patient-demo": [
    {
      "purpose": "care",
      "resources": ["QuestionnaireResponse", "Communication", "Slot"],
      "reference": "Consent/patient-demo-care",
      "grantedAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2030-01-01T00:00:00Z"
    }
  ]
}
EOF
    record_helper "${CONSENT_FIXTURE_PATH}"
  fi
}

ensure_booking_stub() {
  if [ ! -f "${BOOKING_STUB_PATH}" ]; then
    cat <<'EOF' > "${BOOKING_STUB_PATH}"
#!/usr/bin/env node

const http = require('node:http');
const { URL } = require('node:url');

const port = Number(process.env.BOOKING_STUB_PORT ?? 4002);

const slots = [
  {
    id: 'slot-demo-001',
    start: '2025-07-01T09:00:00Z',
    end: '2025-07-01T09:15:00Z',
    modality: 'in_person',
    location: 'Demo Clinic - Room 101'
  },
  {
    id: 'slot-demo-002',
    start: '2025-07-01T09:30:00Z',
    end: '2025-07-01T09:45:00Z',
    modality: 'phone',
    location: 'Virtual Visit'
  },
  {
    id: 'slot-demo-003',
    start: '2025-07-01T10:00:00Z',
    end: '2025-07-01T10:15:00Z',
    modality: 'in_person',
    location: 'Demo Clinic - Room 102'
  }
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (req.method === 'GET' && url.pathname === '/slots') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ slots }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', source: 'booking-stub', ready: true }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, () => {
  console.log(`[booking-stub] listening on http://127.0.0.1:${port}`);
});
EOF
    chmod +x "${BOOKING_STUB_PATH}"
    record_helper "${BOOKING_STUB_PATH}"
  fi
}

ensure_portal_proxy() {
  if [ ! -f "${PORTAL_PROXY_PATH}" ]; then
    cat <<'EOF' > "${PORTAL_PROXY_PATH}"
#!/usr/bin/env node

const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, createHmac, createHash } = require('node:crypto');

const targetBase = process.env.PORTAL_PROXY_TARGET ?? 'http://127.0.0.1:3001';
const port = Number(process.env.PORTAL_PROXY_PORT ?? 4000);
const practiceId = process.env.PORTAL_PROXY_PRACTICE ?? process.env.PRACTICE_ID ?? 'demo';
const patientId = process.env.PORTAL_PROXY_PATIENT ?? 'patient-123';
const scope = process.env.PORTAL_PROXY_SCOPE ?? 'submit triage:submit booking:read';
const secret = process.env.SECURITY_SHARED_SECRET ?? 'dev-shared-secret';

const corsHeaders = (extra = {}) => ({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'cache-control': 'no-store',
  ...extra
});

const respondWithJson = (res, status, payload, extraHeaders = {}) => {
  res.writeHead(status, corsHeaders({ 'content-type': 'application/json', ...extraHeaders }));
  res.end(JSON.stringify(payload));
};

const respondWithText = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, corsHeaders(extraHeaders));
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const toBase64Url = (buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');

const signFingerprint = (fingerprint) => {
  const hmac = createHmac('sha256', secret);
  hmac.update(fingerprint);
  return toBase64Url(hmac.digest());
};

const normalizeString = (value) => (typeof value === 'string' ? value : '');

const deriveIdempotencyKey = (submission, actor) => {
  const hash = createHash('sha256');
  const base = {
    practiceId: normalizeString(submission?.practiceId),
    patientId: normalizeString(submission?.patient?.id),
    narrativeLength: submission?.narrative ? submission.narrative.length : 0,
    channel: normalizeString(submission?.channel),
    attachmentsCount: Array.isArray(submission?.attachments) ? submission.attachments.length : 0
  };
  hash.update(JSON.stringify(base));

  if (submission?.narrative) {
    const narrativeDigest = createHash('sha256').update(String(submission.narrative)).digest('hex');
    hash.update(narrativeDigest);
  }

  if (Array.isArray(submission?.attachments) && submission.attachments.length > 0) {
    const attachmentDigests = submission.attachments
      .map((attachment) => {
        const attHash = createHash('sha256');
        attHash.update(String(attachment?.contentType ?? ''));
        attHash.update('\u0000');
        attHash.update(String(attachment?.url ?? ''));
        return attHash.digest('hex');
      })
      .sort();

    for (const digest of attachmentDigests) {
      hash.update(digest);
    }
  }

  if (actor) {
    hash.update(`:${actor}`);
  }

  return hash.digest('hex');
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      respondWithJson(res, 200, { status: 'ok', proxy: true, target: targetBase });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/safety-check') {
      const raw = await readBody(req);
      let submission;
      try {
        submission = JSON.parse(raw);
      } catch (error) {
        respondWithJson(res, 400, { error: 'invalid_json', detail: String(error) });
        return;
      }

      const requestId = randomUUID();
      const correlationId = randomUUID();
      const idempotencyKey = deriveIdempotencyKey(submission, patientId);
      const fingerprint = `${requestId}:${idempotencyKey}`;
      const signature = signFingerprint(fingerprint);

      const headers = {
        authorization: `Bearer ${signature}`,
        'content-type': 'application/json',
        'x-actor-type': 'patient',
        'x-actor-id': patientId,
        'x-auth-scope': scope,
        'x-request-id': requestId,
        'x-correlation-id': correlationId,
        'x-idempotency-key': idempotencyKey,
        'x-practice-id': practiceId
      };

      const upstream = await fetch(`${targetBase}/safety-check`, {
        method: 'POST',
        headers,
        body: raw
      });

      const text = await upstream.text();
      const correlation =
        upstream.headers.get('x-correlation-id') ??
        upstream.headers.get('x-idempotency-key') ??
        correlationId;

      respondWithText(res, upstream.status, text, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-correlation-id': correlation
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/booking/slots') {
      const requestId = randomUUID();
      const correlationId = randomUUID();
      const fingerprint = `${requestId}:booking:slots`;
      const signature = signFingerprint(fingerprint);

      const upstreamUrl = new URL('/booking/slots', targetBase);
      upstreamUrl.search = url.searchParams.toString();

      const headers = {
        authorization: `Bearer ${signature}`,
        accept: 'application/json',
        'x-request-id': requestId,
        'x-correlation-id': correlationId,
        'x-actor-type': 'patient',
        'x-actor-id': patientId,
        'x-auth-scope': scope,
        'x-patient-id': url.searchParams.get('patientId') ?? patientId,
        'x-practice-id': practiceId
      };

      const upstream = await fetch(upstreamUrl, { method: 'GET', headers });
      const text = await upstream.text();
      const responseHeaders = {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-correlation-id': upstream.headers.get('x-correlation-id') ?? correlationId
      };
      const upstreamCorrelation = upstream.headers.get('x-upstream-correlation-id');
      if (upstreamCorrelation) {
        responseHeaders['x-upstream-correlation-id'] = upstreamCorrelation;
      }
      respondWithText(res, upstream.status, text, responseHeaders);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/booking/appointments') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }

      const slotId = typeof payload?.slotId === 'string' ? payload.slotId : 'slot-demo-001';
      const appointmentId = `appt-${Date.now()}`;
      const bookingStart = typeof payload?.start === 'string' ? payload.start : new Date().toISOString();
      const bookingEnd = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const correlationId = randomUUID();

      respondWithJson(
        res,
        200,
        {
          appointmentId,
          slotId,
          start: bookingStart,
          end: bookingEnd,
          correlationId
        },
        { 'x-correlation-id': correlationId }
      );
      return;
    }

    respondWithJson(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    console.error('[portal-proxy] error', error);
    respondWithJson(res, 502, { error: 'proxy_failure', detail: String(error) });
  }
});

server.listen(port, () => {
  console.log(`[portal-proxy] listening on http://127.0.0.1:${port} -> ${targetBase}`);
  console.log(`[portal-proxy] practice=${practiceId} patient=${patientId} scope="${scope}"`);
});
EOF
    chmod +x "${PORTAL_PROXY_PATH}"
    record_helper "${PORTAL_PROXY_PATH}"
  fi
}

ensure_playwright_config() {
  if [ ! -f "${PLAYWRIGHT_CONFIG_PATH}" ]; then
    cat <<'EOF' > "${PLAYWRIGHT_CONFIG_PATH}"
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '../apps/portal/tests/e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PORTAL_E2E_BASE_URL ?? 'http://localhost:5173',
    headless: process.env.PORTAL_E2E_HEADLESS !== 'false'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
EOF
    record_helper "${PLAYWRIGHT_CONFIG_PATH}"
  fi
}

divider() {
  printf '%s%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$ACCENT" "$BOLD" "$RESET"
}

banner() {
  divider
  printf '%s%s╭────────────────────────────────────────────────────────────╮%s\n' "$ACCENT_LIGHT" "$BOLD" "$RESET"
  printf '%s%s│  WALK WITH ME • ONECARE PREMIUM TEST TOUR               │%s\n' "$ACCENT_LIGHT" "$BOLD" "$RESET"
  printf '%s%s╰────────────────────────────────────────────────────────────╯%s\n' "$ACCENT_LIGHT" "$BOLD" "$RESET"
  divider
  printf '\n'
}

progress_bar() {
  local current="$1"
  local total="$2"
  local width=26
  local done_units=$(( (current - 1) * width / total ))
  local percent=$(( (current - 1) * 100 / total ))
  if [ "$current" -ge "$total" ]; then
    done_units=$width
    percent=100
  fi

  printf '%s[' "$DIM"
  for ((i=0; i<done_units; i++)); do
    printf '%s█' "$SUCCESS"
  done
  for ((i=done_units; i<width; i++)); do
    printf '%s░' "$DIM"
  done
  printf '%s]%s %3d%%%s\n' "$RESET" "$DIM" "$percent" "$RESET"
}

section() {
  printf '\n'
  divider
  local current=${STEP}
  printf '%s%s%s Step %02d/%02d %s %s%s\n' "$ACCENT_LIGHT" "$BOLD" "$ICON_STEP" "${current}" "${TOTAL_STEPS}" "$1" "$RESET"
  progress_bar "$current" "$TOTAL_STEPS"
  printf '%s%s──────────────────────────────────────────────────────────────%s\n\n' "$ACCENT" "$DIM" "$RESET"
  STEP=$((STEP + 1))
}

pause() {
  printf '%s%s┌──────────────────────────────────────────────┐%s\n' "$PANEL_EDGE" "$DIM" "$RESET"
  printf '%s│%s %s %sPress Enter in Terminal 1 to continue... %s%s│%s\n' \
    "$PANEL_EDGE" "$RESET" "$ICON_INFO" "$ITALIC" "$RESET" "$PANEL_EDGE" "$RESET"
  printf '%s%s└──────────────────────────────────────────────┘%s' "$PANEL_EDGE" "$DIM" "$RESET"
  read -r _ || true
  printf '\n'
}

show_command() {
  local terminal="$1"
  local command_text="$2"
  printf '%s%s┌─ %s ───────────────────────────┐%s\n' "$PANEL_EDGE" "$DIM" "$terminal" "$RESET"
  printf '%s│%s %s%s%s %s│%s\n' "$PANEL_EDGE" "$RESET" "$CMD" "${command_text}" "$RESET" "$PANEL_EDGE" "$RESET"
  printf '%s%s└──────────────────────────────────────────────┘%s\n\n' "$PANEL_EDGE" "$DIM" "$RESET"
}

banner

section "Welcome and how this works"
cat <<EOF
${BOLD}${ACCENT}Welcome aboard!${RESET} This premium walkthrough covers the entire ONECARE project:
  ${SUCCESS}✓${RESET} TypeScript build, lint, unit, contract, and end-to-end state-machine tests.
  ${SUCCESS}✓${RESET} Python ML service test suites with virtual environments.
  ${SUCCESS}✓${RESET} Runtime bring-up: Safety Gate, Orchestrator, booking availability stub, signing proxy.
  ${SUCCESS}✓${RESET} Portal UI manual checks plus Playwright and accessibility audits.
  ${SUCCESS}✓${RESET} Signed API verification to exercise zero-trust headers.

Keep this window open as ${BOLD}"Terminal 1: Guide"${RESET}. When asked, open additional terminals (Terminal 2, Terminal 3, …), run the commands exactly as shown, then return here and press Enter.
EOF
pause

section "Confirm your project path"
cat <<EOF
${INFO}Project root detected:${RESET}
  ${BOLD}${ROOT_DIR}${RESET}

We will reference this path in commands below. Copy it if you plan to paste it into other terminals.
EOF
pause

section "Check required tools"
cat <<EOF
${BOLD}Prerequisite check${RESET}
We need recent versions of Node.js, npm, Python (3.10+), and Playwright CLI (bundled with npm). Detected versions:
EOF

if command -v node >/dev/null 2>&1; then
  printf '  %s•%s Node.js: %s%s%s\n' "$ACCENT" "$RESET" "$BOLD" "$(node --version)" "$RESET"
else
  printf '  %s• Node.js: not found%s (install Node.js 20 or newer from https://nodejs.org/).\n' "$WARN" "$RESET"
fi

if command -v npm >/dev/null 2>&1; then
  printf '  %s•%s npm: %s%s%s\n' "$ACCENT" "$RESET" "$BOLD" "$(npm --version)" "$RESET"
else
  printf '  %s• npm: not found%s (npm ships with Node.js; reinstall Node.js if missing).\n' "$WARN" "$RESET"
fi

PYTHON_FOUND="no"
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    PY_VERSION="$("${candidate}" --version 2>/dev/null || true)"
    printf '  %s•%s Python: %s%s%s (%s)\n' "$ACCENT" "$RESET" "$BOLD" "${candidate}" "$RESET" "${PY_VERSION}"
    PYTHON_FOUND="yes"
    break
  fi
done

if [ "${PYTHON_FOUND}" = "no" ]; then
  printf '  %s• Python: not found%s (install Python 3.11 from https://www.python.org/downloads/).\n' "$WARN" "$RESET"
fi

cat <<EOF
If anything is missing, install it first. We will install Playwright browsers later in the tour.
EOF
pause

section "Prepare Terminal 2 for Node.js tasks"
cat <<EOF
Open a new terminal window/tab and keep this script running here.
We will call the new window ${BOLD}"Terminal 2: Node workspace"${RESET}.

In Terminal 2, change into the project directory and verify the location:
EOF
show_command "Terminal 2" "cd \"${ROOT_DIR}\""
show_command "Terminal 2" "pwd    # should print ${ROOT_DIR}"
cat <<EOF
Stay in Terminal 2; we will reuse it for most JavaScript/TypeScript commands.
EOF
pause

section "Install Node.js dependencies"
cat <<EOF
Install all workspace dependencies (this can take a few minutes).

You can let the guide run ${CMD}npm ci${RESET} for you or run it manually in Terminal 2.
EOF
read -r -p "Would you like the guide to run npm ci now? [y/N] " run_npm_ci || true

if [[ "${run_npm_ci:-}" =~ ^[Yy]$ ]]; then
  printf '\n%sStarting npm ci in %s...%s\n' "$INFO" "${ROOT_DIR}" "$RESET"
  if npm ci; then
    printf '\n%s%sSuccess! npm ci completed without errors.%s\n' "$SUCCESS" "$BOLD" "$RESET"
  else
    printf '\n%sIssue detected.%s Review the output above, resolve the problem, then run %snpm ci%s in Terminal 2 before continuing.\n' "$WARN" "$RESET" "$CMD" "$RESET"
  fi
else
  cat <<EOF
In Terminal 2 run:
  ${CMD}npm ci${RESET}

Expected outcome:
  - node_modules/ folders get recreated for each workspace.
  - Finish with a message such as “added ### packages” and exit code 0.
EOF
fi
pause

section "Build the TypeScript workspaces"
cat <<EOF
Ensure every workspace compiles cleanly. In Terminal 2 run:
  ${CMD}npm run build${RESET}

Expected outcome:
  - Each workspace logs its build progress.
  - Command exits with status 0 (no red TypeScript errors).
Resolve any issues before moving on.
EOF
pause

section "Run the TypeScript typecheck"
cat <<EOF
Now run the project-wide incremental typecheck:
  ${CMD}npm run typecheck${RESET}

Expected outcome:
  - TypeScript lists each project it checks.
  - Final line indicates “Found 0 errors”.
Address any reported issues.
EOF
pause

section "Run the TypeScript unit tests"
cat <<EOF
Execute the Vitest suite across all packages and apps:
  ${CMD}npm run test${RESET}

Expected outcome:
  - Vitest prints per-file summaries.
  - Ends with “Test Files ## passed” and exit code 0.
EOF
pause

section "Run extended TypeScript checks"
cat <<EOF
Run the additional guards expected by the repo:
  ${CMD}npm run lint${RESET}             ${DIM}# ESLint (style + best practices)${RESET}
  ${CMD}npm run codegen:check${RESET}    ${DIM}# Confirms schema/codegen outputs are in sync${RESET}

Expected outcome:
  - Lint reports “0 problems” or lists lines to fix.
  - Codegen check ends with a dry-run success message and no diffs.
Fix any findings before continuing.
EOF
pause

section "Optional: additional TypeScript coverage"
cat <<EOF
If you want per-function coverage numbers, run:
  ${CMD}npx vitest run --coverage${RESET}

Coverage runs take longer; feel free to skip unless you need the metrics.
EOF
pause

section "Run orchestrator and booking end-to-end tests"
cat <<EOF
Execute the state-machine end-to-end suites (they start their own in-memory services). In Terminal 2 run:
  ${CMD}bash scripts/e2e/triage_flow.sh${RESET}
  ${CMD}bash scripts/e2e/booking_flow.sh${RESET}

Expected outcome:
  - Triage flow publishes triage.input and tasks.created envelopes with matching correlation IDs.
  - Booking flow searches slots, books, and emits booking.appointmentCreated.
EOF
pause

section "Optional: NATS smoke guard"
cat <<EOF
If you have a NATS instance available (or want to test the local guard), run:
  ${CMD}npm run smoke:nats${RESET}

Skip this if you do not have NATS configured locally.
EOF
pause

section "Install Playwright browsers (first run only)"
cat <<EOF
Playwright needs to download the Chromium browser once. In Terminal 2 run:
  ${CMD}npx playwright install --with-deps${RESET}

You can skip if you installed Playwright browsers recently on this machine.
EOF
pause

section "Set up Terminal 3 for Python services"
cat <<EOF
Open another terminal and name it ${BOLD}"Terminal 3: Python workspace"${RESET}.
Change into the Python services directory:
EOF
show_command "Terminal 3" "cd \"${ROOT_DIR}/services-py\""
show_command "Terminal 3" "pwd    # should end with services-py"
cat <<EOF
Keep Terminal 3 open; we will use it for tests and to host the Safety Gate service.
EOF
pause

section "Run the Python test suite"
cat <<EOF
In Terminal 3 run:
  ${CMD}./run-tests.sh${RESET}

Expected outcome:
  - A virtual environment (\`.venv\`) is created if missing.
  - requirements-dev.txt dependencies install quietly.
  - Pytest ends with “=== X passed” (all tests green).
Fix any failures before moving on.
EOF
pause

section "Keep the virtual environment handy"
cat <<EOF
Activate the freshly created virtual environment so uvicorn uses the same interpreter:
EOF
show_command "Terminal 3" "source .venv/bin/activate"
cat <<EOF
Your prompt should now start with “(.venv)”. If you open a new shell later, activate it again before running Python commands.
EOF
pause

section "Start the Safety Gate service (Python)"
cat <<EOF
With the venv active, launch the Safety Gate FastAPI service in Terminal 3:
EOF
show_command "Terminal 3" "uvicorn safety_gate_service.main:app --reload --port 8081"
cat <<EOF
Keep this terminal running.
Expected outcome:
  - Logs show “Uvicorn running on http://127.0.0.1:8081”.
  - Requests will stream here while we exercise the system.
EOF
pause

section "Prepare helper fixtures and mock services"
cat <<EOF
To simplify local end-to-end testing, I will stage helper files inside ${BOLD}${HELPER_DIR}${RESET}:
  ${ACCENT_LIGHT}•${RESET} consent-fixture.json — pre-approved consents for demo patients (used via CONSENT_CACHE).
  ${ACCENT_LIGHT}•${RESET} booking-stub.js — lightweight booking availability API (GET /slots).
  ${ACCENT_LIGHT}•${RESET} portal-proxy.js — signing proxy that injects zero-trust headers for the portal.
  ${ACCENT_LIGHT}•${RESET} portal-playwright.local.config.ts — Playwright config without auto webServer.
EOF

ensure_consent_fixture
ensure_booking_stub
ensure_portal_proxy
ensure_playwright_config

if [ "${#helpers_created[@]}" -gt 0 ]; then
  printf '\n%sCreated helper files:%s\n' "$SUCCESS" "$RESET"
  for helper in "${helpers_created[@]}"; do
    printf '  - %s\n' "$helper"
  done
else
  printf '\n%sHelpers already in place. Great!%s\n' "$INFO" "$RESET"
fi
pause

section "Export runtime environment variables in Terminal 2"
cat <<EOF
Return to Terminal 2 and export the environment needed for the orchestrator.
EOF
show_command "Terminal 2" "export SECURITY_SHARED_SECRET='portal-dev-shared-secret'"
show_command "Terminal 2" "export PRACTICE_ID='demo'"
show_command "Terminal 2" "export CONSENT_CACHE=\"\$(cat '${CONSENT_FIXTURE_PATH}')\""
show_command "Terminal 2" "export BOOKING_AVAILABILITY_URL='http://localhost:4002/'"
show_command "Terminal 2" "export BUS_IMPL='memory'"
cat <<EOF
These exports keep working as long as Terminal 2 stays open. If you start a fresh shell later, run the exports again.
EOF
pause

section "Start the booking availability stub"
cat <<EOF
Open another terminal and call it ${BOLD}"Terminal 4: Booking stub"${RESET}.
Start the stub service that serves GET /slots for local booking tests:
EOF
show_command "Terminal 4" "node \"${BOOKING_STUB_PATH}\""
cat <<EOF
Expected outcome:
  - Logs show “[booking-stub] listening on http://127.0.0.1:4002”.
  - Keep it running while testing booking flows.
EOF
pause

section "Start the Orchestrator service (Node.js)"
cat <<EOF
Back in Terminal 2, launch the Orchestrator using the environment you exported.
EOF
show_command "Terminal 2" "PORT=3001 node apps/orchestrator/dist/index.js"
cat <<EOF
Expected outcome:
  - Logs show practice configuration and “server listening on :3001”.
  - The process keeps running; do not close this terminal.
EOF
pause

section "Optional: watch the triage worker"
cat <<EOF
If you want to see triage.input envelopes consumed, open ${BOLD}"Terminal 5: Triage worker"${RESET} and run:
EOF
show_command "Terminal 5" "cd \"${ROOT_DIR}\""
show_command "Terminal 5" "npm -w @onecare/app-triage run build"
show_command "Terminal 5" "node apps/triage/dist/dev/worker.js"
cat <<EOF
Leave it running to observe triage events when we submit portal intakes.
EOF
pause

section "Start the signing proxy for the portal"
cat <<EOF
Open ${BOLD}"Terminal 6: Portal proxy"${RESET} and start the zero-trust signing proxy:
EOF
show_command "Terminal 6" "PORTAL_PROXY_PATIENT='patient-123' PORTAL_PROXY_PRACTICE='demo' node \"${PORTAL_PROXY_PATH}\""
cat <<EOF
Expected outcome:
  - Logs show “[portal-proxy] listening on http://127.0.0.1:4000 -> http://127.0.0.1:3001”.
  - The proxy adds signatures, actors, scopes, and idempotency keys for the portal.
EOF
pause

section "Prepare Terminal 7 for the portal UI"
cat <<EOF
Open ${BOLD}"Terminal 7: Portal UI"${RESET}, change into the repo root, and verify the path:
EOF
show_command "Terminal 7" "cd \"${ROOT_DIR}\""
show_command "Terminal 7" "pwd"
pause

section "Start the Portal dev server"
cat <<EOF
Still in Terminal 7, start the Vite dev server pointed at the signing proxy:
EOF
show_command "Terminal 7" "VITE_ORCH_URL='http://localhost:4000' VITE_BOOKING_API_URL='http://localhost:4000' npm -w @onecare/app-portal run dev"
cat <<EOF
Expected outcome:
  - Vite prints “Local: http://localhost:5173/”.
  - Keep this running while testing the UI.
EOF
pause

section "Manual UI check ▸ Intake flow"
cat <<EOF
Open your browser to ${BOLD}http://localhost:5173/intake${RESET}. Walk through the intake flow:
  ${SUCCESS}✓${RESET} Switch the language between English and Spanish; headings update instantly.
  ${SUCCESS}✓${RESET} Fill Practice ID ${CMD}demo${RESET}, Patient ID ${CMD}patient-123${RESET}, narrative “Patient reports mild symptoms.”.
  ${SUCCESS}✓${RESET} Submit. Expect “Submission received” with a reference number.
  ${SUCCESS}✓${RESET} Terminal 2 logs “published triage.input”; Terminal 3 logs POST /analyze; optional Terminal 5 logs the triage worker event.
  ${SUCCESS}✓${RESET} Refresh and submit without filling fields to confirm localized validation errors appear.
EOF
pause

section "Manual UI check ▸ Booking flow"
cat <<EOF
Navigate to ${BOLD}http://localhost:5173/booking${RESET} and verify booking behaviors:
  ${SUCCESS}✓${RESET} Initial slot list loads from the booking stub (check Terminal 4/2 logs).
  ${SUCCESS}✓${RESET} Filter by modality/date and confirm the list updates.
  ${SUCCESS}✓${RESET} Select a slot → confirm. The proxy returns a stub confirmation with appointmentId + correlationId.
  ${SUCCESS}✓${RESET} Click “Book another appointment” to reset the flow.
EOF
pause

section "Run portal Playwright end-to-end tests"
cat <<EOF
With the portal dev server still running (Terminal 7), execute the Playwright suite from Terminal 2:
EOF
show_command "Terminal 2" "PORTAL_E2E_ENABLE=true PORTAL_E2E_BASE_URL='http://localhost:5173' npx playwright test --config \"${PLAYWRIGHT_CONFIG_PATH}\""
cat <<EOF
Expected outcome:
  - Tests switch locales, submit intake, and validate error handling.
  - Summary ends with “1 passed” (or the number of enabled specs).
Add ${CMD}--headed${RESET} if you want to watch the browser while it runs.
EOF
pause

section "Run portal accessibility audit"
cat <<EOF
Still in Terminal 2, run the axe-powered accessibility audit:
EOF
show_command "Terminal 2" "npm --workspace @onecare/app-portal run a11y:ci"
cat <<EOF
Expected outcome:
  - Each route reports “No critical issues”.
  - Non-zero exit indicates accessibility fixes are needed.
EOF
pause

section "Send a signed safety-check request"
cat <<EOF
From Terminal 2 (or any spare terminal), call the signing proxy directly:
EOF
show_command "Terminal 2" "curl -s -X POST http://localhost:4000/safety-check \\\n  -H 'content-type: application/json' \\\n  -d '{\"practiceId\":\"demo\",\"patient\":{\"id\":\"patient-123\"},\"narrative\":\"Manual API test\",\"channel\":\"web\"}'"
cat <<EOF
Expected outcome:
  - JSON response with outcome SAFE_TO_CONTINUE and a correlationId.
  - Terminal 2 logs “published triage.input”; Terminal 3 logs the Safety Gate request.
EOF
pause

section "Fetch booking slots via proxy"
cat <<EOF
Confirm the orchestrator proxy for slots returns stub data:
EOF
show_command "Terminal 2" "curl -s 'http://localhost:4000/booking/slots?modality=in_person'"
cat <<EOF
Expected outcome:
  - JSON payload listing the demo slots from the stub.
  - Terminal 2 logs “booking slots” request; Terminal 4 logs the stub access.
EOF
pause

section "Cleanup"
cat <<EOF
${SUCCESS}${BOLD}Fantastic work!${RESET} Shut everything down neatly:
  - Terminal 7 (Portal dev server): press Ctrl+C.
  - Terminal 6 (Portal proxy): Ctrl+C.
  - Terminal 5 (triage worker, if running): Ctrl+C.
  - Terminal 4 (booking stub): Ctrl+C.
  - Terminal 3 (Safety Gate): Ctrl+C, then run ${CMD}deactivate${RESET}.
  - Terminal 2 (Orchestrator): Ctrl+C.
  - Close any extra terminals you used for curls/tests.

Optional: remove helper files later with ${CMD}rm -rf ${HELPER_DIR}${RESET} once you no longer need them.
EOF

printf '\n%s%sAll steps complete.%s %sThanks for using walkwithme.sh!%s\n' "$SUCCESS" "$BOLD" "$RESET" "$INFO" "$RESET"
