#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
STATE_DIR="$ROOT_DIR/.dev-all"
HELPER_DIR="$STATE_DIR/helpers"
PIDS_DIR="$STATE_DIR/pids"

mkdir -p "$HELPER_DIR" "$PIDS_DIR"

log() { printf "[dev-all] %s\n" "$*"; }
die() { printf "[dev-all] ERROR: %s\n" "$*" >&2; exit 1; }

# --- Load .env defaults if present ---
if [[ -f "$ROOT_DIR/.env" ]]; then
  log "loading environment defaults from .env"
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

# --- Determine runtimes and helpers ---
UVICORN_BIN=""
if [[ -x "$ROOT_DIR/services-py/.venv/bin/uvicorn" ]]; then
  UVICORN_BIN="$ROOT_DIR/services-py/.venv/bin/uvicorn"
elif command -v uvicorn >/dev/null 2>&1; then
  UVICORN_BIN="$(command -v uvicorn)"
fi

require_port_free() {
  local port="$1"
  local label="$2"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      die "Port ${port} already in use (${label}). Stop conflicting service or run npm run --workspaces=false dev:all:stop first."
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if python3 - <<PY >/dev/null 2>&1
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.connect(("127.0.0.1", ${port}))
except OSError:
    sys.exit(1)
else:
    sys.exit(0)
finally:
    s.close()
PY
    then
      die "Port ${port} already in use (${label})."
    fi
  fi
}

cleanup_leftovers() {
  if [[ -d "$PIDS_DIR" ]]; then
    for pidfile in "$PIDS_DIR"/*.pid; do
      [[ -e "$pidfile" ]] || continue
      local pid
      pid=$(cat "$pidfile" 2>/dev/null || true)
      if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
        log "stopping leftover process (pid ${pid}) from $(basename "$pidfile")"
        kill "$pid" 2>/dev/null || true
        sleep 0.2
        if kill -0 "$pid" 2>/dev/null; then
          kill -9 "$pid" 2>/dev/null || true
        fi
      fi
      rm -f "$pidfile"
    done
  fi
}

cleanup_leftovers

# --- Preflight checks ---
command -v node >/dev/null 2>&1 || die "node is required on PATH"
command -v npm >/dev/null 2>&1 || die "npm is required on PATH"
if [[ -z "$UVICORN_BIN" ]]; then
  log "uvicorn not found; Python services may not run (try: make py-safety)"
fi

if [[ -z "${FHIR_BASE_URL:-}" ]]; then
  cat >&2 <<EOF
[dev-all] FHIR_BASE_URL is not set.
  Set a reachable FHIR endpoint first, e.g.:
    export FHIR_BASE_URL="https://fhir-dev.example.com"
    export FHIR_TOKEN="<bearer token>"   # or FHIR_AUTH_TOKEN
    export FHIR_HEALTH_PATH="_ping"      # NHS INT endpoints use _ping instead of /metadata
    export FHIR_API_KEY="<subscription key>"  # Required for NHS API Platform gateways
EOF
  exit 1
fi

# Provide defaults for local zero‑trust proxy
: "${SECURITY_SHARED_SECRET:=dev-shared-secret}"
: "${PRACTICE_ID:=demo}"
SAFETY_GATE_PORT=${SAFETY_GATE_PORT:-8081}
BOOKING_STUB_PORT=${BOOKING_STUB_PORT:-4002}
ORCHESTRATOR_PORT=${ORCHESTRATOR_PORT:-3001}
PORTAL_PROXY_PORT=${PORTAL_PROXY_PORT:-4000}

# --- Generate consent fixture if missing ---
CONSENT_FIXTURE="$HELPER_DIR/consent-fixture.json"
if [[ ! -f "$CONSENT_FIXTURE" ]]; then
  cat >"$CONSENT_FIXTURE" <<'JSON'
{
  "patient-123": [
    {
      "purpose": "care",
      "resources": ["QuestionnaireResponse", "Communication", "Slot"],
      "reference": "Consent/patient-123-care",
      "grantedAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2030-01-01T00:00:00Z"
    }
  ]
}
JSON
  log "created $CONSENT_FIXTURE"
fi

# --- Generate booking stub if missing ---
BOOKING_STUB="$HELPER_DIR/booking-stub.js"
if [[ ! -f "$BOOKING_STUB" ]]; then
  cat >"$BOOKING_STUB" <<'JS'
#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.env.BOOKING_STUB_PORT ?? 4002);
const slots = [
  { id: 'slot-demo-001', start: '2025-07-01T09:00:00Z', end: '2025-07-01T09:15:00Z', modality: 'in_person', location: 'Demo Clinic - Room 101' },
  { id: 'slot-demo-002', start: '2025-07-01T09:30:00Z', end: '2025-07-01T09:45:00Z', modality: 'phone',     location: 'Virtual Visit' },
  { id: 'slot-demo-003', start: '2025-07-01T10:00:00Z', end: '2025-07-01T10:15:00Z', modality: 'in_person', location: 'Demo Clinic - Room 102' }
];
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url || '').startsWith('/slots')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ slots }));
    return;
  }
  if (req.method === 'GET' && (req.url || '').startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', source: 'booking-stub', ready: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
server.listen(port, () => console.log(`[booking-stub] listening on http://127.0.0.1:${port}`));
JS
  chmod +x "$BOOKING_STUB"
  log "created $BOOKING_STUB"
fi

# --- Generate signing proxy if missing ---
PROXY="$HELPER_DIR/portal-proxy.js"
if [[ ! -f "$PROXY" ]]; then
  # Reuse the proven proxy from walkwithme
  awk 'BEGIN{p=0} /portal-proxy.js/{p=1} p==1{print} /record_helper/{if(p==1){exit}}' "$ROOT_DIR/walkwithme.sh" \
    | sed -n '/^#!/,$p' > "$PROXY" || true
  if [[ ! -s "$PROXY" ]]; then
    # Fallback to minimal embedded proxy if walkwithme format changes
    cat >"$PROXY" <<'JS'
#!/usr/bin/env node
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, createHmac } = require('node:crypto');
const targetBase = process.env.PORTAL_PROXY_TARGET ?? 'http://127.0.0.1:3001';
const port = Number(process.env.PORTAL_PROXY_PORT ?? 4000);
const practiceId = process.env.PORTAL_PROXY_PRACTICE ?? 'demo';
const patientId = process.env.PORTAL_PROXY_PATIENT ?? 'patient-123';
const scope = process.env.PORTAL_PROXY_SCOPE ?? 'submit triage:submit booking:read';
const secret = process.env.SECURITY_SHARED_SECRET ?? 'dev-shared-secret';
const toB64Url = (b) => b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sign = (s) => toB64Url(createHmac('sha256', secret).update(s).digest());
const read = (req) => new Promise((r,j)=>{const c=[];req.on('data',x=>c.push(Buffer.from(x)));req.on('end',()=>r(Buffer.concat(c).toString('utf8')));req.on('error',j);});
const srv = http.createServer(async (req,res)=>{
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST,OPTIONS'});res.end();return;}
  const cors={'access-control-allow-origin':'*','cache-control':'no-store'};
  if (req.method==='POST' && url.pathname==='/safety-check'){
    const raw=await read(req); const body=raw; const requestId=randomUUID(); const corr=randomUUID();
    const idem = randomUUID(); const sig=sign(`${requestId}:${idem}`);
    const headers={authorization:`Bearer ${sig}`,'content-type':'application/json','x-actor-type':'patient','x-actor-id':patientId,'x-auth-scope':scope,'x-request-id':requestId,'x-correlation-id':corr,'x-idempotency-key':idem,'x-practice-id':practiceId};
    const upstream = await fetch(`${targetBase}/safety-check`,{method:'POST',headers,body});
    const text = await upstream.text();
    res.writeHead(upstream.status,{...cors,'content-type':upstream.headers.get('content-type')||'application/json','x-correlation-id':upstream.headers.get('x-correlation-id')||corr});
    res.end(text); return;
  }
  if (req.method==='GET' && url.pathname==='/booking/slots'){
    const requestId=randomUUID(); const corr=randomUUID(); const sig=sign(`${requestId}:booking:slots`);
    const upstreamUrl=new URL('/booking/slots',targetBase); upstreamUrl.search=url.searchParams.toString();
    const headers={authorization:`Bearer ${sig}`,'accept':'application/json','x-request-id':requestId,'x-correlation-id':corr,'x-actor-type':'patient','x-actor-id':patientId,'x-auth-scope':scope,'x-patient-id':url.searchParams.get('patientId')||patientId,'x-practice-id':practiceId};
    const upstream=await fetch(upstreamUrl,{method:'GET',headers}); const text=await upstream.text();
    res.writeHead(upstream.status,{...cors,'content-type':upstream.headers.get('content-type')||'application/json','x-correlation-id':upstream.headers.get('x-correlation-id')||corr});
    res.end(text); return;
  }
  if (req.method==='POST' && url.pathname==='/booking/appointments'){
    const corr=randomUUID();
    res.writeHead(200,{...cors,'content-type':'application/json','x-correlation-id':corr});
    res.end(JSON.stringify({appointmentId:`appt-${Date.now()}`,slotId:'slot-demo-001',start:new Date().toISOString(),end:new Date(Date.now()+15*60*1000).toISOString(),correlationId:corr}));
    return;
  }
  res.writeHead(404,{...cors,'content-type':'application/json'}); res.end(JSON.stringify({error:'not_found'}));
});
srv.listen(port,()=>console.log(`[portal-proxy] listening on http://127.0.0.1:${port} -> ${targetBase}`));
JS
  fi
  chmod +x "$PROXY"
  log "created $PROXY"
fi

# --- Build orchestrator ---
log "building orchestrator"
(cd "$ROOT_DIR" && npm -w @onecare/app-orchestrator run build --silent)

# --- Start services ---
start_bg() { (
  set -e; "$@" & echo $! >"$PIDS_DIR/$(basename "$1").pid"; ) }

# Safety Gate (Python)
if [[ -n "$UVICORN_BIN" ]]; then
  require_port_free "$SAFETY_GATE_PORT" "Safety Gate"
  log "starting Safety Gate on :${SAFETY_GATE_PORT}"
  PYTHONPATH=services-py start_bg "$UVICORN_BIN" safety_gate_service.main:app --port "$SAFETY_GATE_PORT" --log-level warning
else
  log "skipping Safety Gate (uvicorn not found)"
fi

# Booking stub
require_port_free "$BOOKING_STUB_PORT" "booking stub"
log "starting booking stub on :${BOOKING_STUB_PORT}"
BOOKING_STUB_PORT="$BOOKING_STUB_PORT" start_bg node "$BOOKING_STUB"

# Orchestrator (Node)
require_port_free "$ORCHESTRATOR_PORT" "orchestrator"
log "starting Orchestrator on :${ORCHESTRATOR_PORT}"
(
  cd "$ROOT_DIR"
  CONSENT_CACHE="$(cat "$CONSENT_FIXTURE")" \
  PORT="$ORCHESTRATOR_PORT" PRACTICE_ID="$PRACTICE_ID" \
  PY_SAFETY_GATE_URL=${PY_SAFETY_GATE_URL:-http://localhost:${SAFETY_GATE_PORT}} \
  PY_SAFETY_GATE_HOST_ALLOWLIST=${PY_SAFETY_GATE_HOST_ALLOWLIST:-localhost,127.0.0.1} \
  BUS_IMPL=memory \
  SECURITY_SHARED_SECRET="$SECURITY_SHARED_SECRET" \
  BOOKING_AVAILABILITY_URL=${BOOKING_AVAILABILITY_URL:-http://localhost:${BOOKING_STUB_PORT}/} \
  node apps/orchestrator/dist/index.js & echo $! > "$PIDS_DIR/orchestrator.pid"
)

# Proxy
require_port_free "$PORTAL_PROXY_PORT" "signing proxy"
log "starting signing proxy on :${PORTAL_PROXY_PORT}"
PORTAL_PROXY_TARGET="http://127.0.0.1:${ORCHESTRATOR_PORT}" \
PORTAL_PROXY_PRACTICE="$PRACTICE_ID" \
PORTAL_PROXY_PATIENT=${PORTAL_PROXY_PATIENT:-patient-123} \
SECURITY_SHARED_SECRET="$SECURITY_SHARED_SECRET" \
PORTAL_PROXY_PORT="$PORTAL_PROXY_PORT" \
start_bg node "$PROXY"

# Portal (Vite dev)
log "starting Portal dev server (Vite)"
(
  cd "$ROOT_DIR"
  VITE_ORCH_URL=http://localhost:4000 \
  VITE_BOOKING_API_URL=http://localhost:4000 \
  npm -w @onecare/app-portal run dev & echo $! > "$PIDS_DIR/portal.pid"
)

cat <<EOF

[dev-all] Stack starting. Open:
  - Portal UI:            http://localhost:5173
  - Orchestrator health:  http://localhost:3001/health
  - Safety Gate docs:     http://localhost:8081/docs (if uvicorn running)
  - Booking stub health:  http://localhost:4002/health

To stop: npm run dev:all:stop

EOF
