Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-03.4.md) | [Next](SEC-03.6.md)

Task: SEC-03.5 — HTTP/API fuzzing harness (property‑based + ZAP baseline)

Context
- Find robustness issues by fuzzing JSON inputs and running ZAP baseline scans against HTTP endpoints.

Files
- qa/security/fuzz_http.spec.ts (new)
- docs/security/APP_FUZZING.md (new)

Steps
1) Implement property‑based fuzzer for JSON bodies based on schemas to generate edge cases; expect safe error envelopes (no stack traces).
2) Run OWASP ZAP baseline scan against local services; store reports.
3) Document execution in CI (optional) and local runs.

Acceptance Criteria
- Fuzzing harness runs; endpoints handle malformed inputs safely; reports captured.

Validate
- npm run test:fuzz; inspect ZAP reports.

Status Update
- make engineer-done ENGINEER=security/engineer-02 TASK='SEC-03.5' && make team-status-write

