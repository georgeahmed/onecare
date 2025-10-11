Error Handling (HTTP)

Envelope
```json
{
  "error": {
    "code": "invalid_input",
    "message": "short, safe description",
    "details": { "field": "reason" },
    "correlationId": "mgmrux9p-6l3z44"
  }
}
```

Guidelines
- Never return stack traces; log internals server-side with the correlationId.
- Use 4xx for client errors (auth, validation, rate limits); 5xx for server-side failures/timeouts.
- Validate payloads at the edge and redact sensitive headers in logs.
- Propagate `x-correlation-id` (incoming or generated) on every response.

Code → Status Mapping

| Code                     | HTTP | Description                                                         |
|--------------------------|------|---------------------------------------------------------------------|
| `unauthorized`           | 401  | Caller must authenticate (not yet used by orchestrator)             |
| `forbidden`              | 403  | Authenticated actor denied (missing signature, consent, or scope)   |
| `invalid_input`          | 400  | Malformed JSON or schema validation failure                         |
| `unsupported_media_type` | 415  | Content-Type not `application/json`                                 |
| `payload_too_large`      | 413  | Body exceeds configured `MAX_BODY_BYTES`                            |
| `conflict`               | 409  | Idempotency collision/double-submit                                 |
| `too_many_requests`      | 429  | Future rate-limit/surge control                                     |
| `upstream_timeout`       | 504  | Timed out awaiting upstream dependency                              |
| `upstream_unavailable`   | 503  | Dependency or event bus unavailable                                 |
| `busy`                   | 503  | Temporary workstation/service busy (graceful overload)              |
| `invalid_fhir`           | 400  | Payload failed downstream FHIR validation                           |
| `internal_error`         | 500  | Unexpected failure (kept terse, full detail only in logs)           |

Examples (`PRACTICE_ID=demo`, orchestrator on :3001)

403 — Missing authorization
```bash
curl -s -X POST http://localhost:3001/safety-check \
  -H 'content-type: application/json' \
  -H 'x-actor-type: patient' \
  -H 'x-actor-id: demo-patient' \
  -H 'x-request-id: demo-403' \
  -d '{"practiceId":"p1","patient":{"id":"demo"},"narrative":"test","channel":"web"}' | jq
```

415 — Wrong content-type
```bash
curl -s -X POST http://localhost:3001/safety-check \
  -H 'content-type: text/plain' \
  -H 'authorization: Bearer token' \
  -H 'x-actor-type: patient' \
  -H 'x-actor-id: demo-patient' \
  -H 'x-request-id: demo-415' \
  -d 'plain text body' | jq
```

413 — Too large
```bash
python - <<'PY'
import requests
payload = {"practiceId":"p1","patient":{"id":"demo"},"narrative":"x"*300000,"channel":"web"}
headers = {
  "content-type": "application/json",
  "authorization": "Bearer token",
  "x-actor-type": "patient",
  "x-actor-id": "demo-patient",
  "x-request-id": "demo-413",
}
resp = requests.post("http://localhost:3001/safety-check", json=payload, headers=headers)
print(resp.status_code, resp.json())
PY
```

504 — Simulated timeout (set `SAFETY_GATE_TIMEOUT=1` or kill upstream) will return:
```json
{
  "error": {
    "code": "upstream_timeout",
    "message": "Upstream timeout",
    "correlationId": "..."
  }
}
```

All responses include the correlation ID for incident triage. Metrics logs (`metric.http.request`) emit the route, outcome code, and latency so dashboards can track error rates alongside success volume.
