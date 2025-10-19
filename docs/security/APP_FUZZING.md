# HTTP/API Fuzzing & Dynamic Scanning

Last updated: 2025-10-18  
Owners: Security, QA Automation

## Fuzzing Harness

- Location: `qa/security/fuzz_http.spec.ts`
- Uses `fast-check` to mutate JSON payloads based on existing schemas and ensures services return safe error envelopes (no stack traces, proper status codes).
- Run locally with dev stack: `npm run test:fuzz`.
- Extend by adding new targets in `TARGETS` array.

## SSRF Tests

- Location: `qa/security/ssrf.spec.ts`
- Simulates redirects to private and metadata IPs to confirm SSRF guardrails block them. Requires booking proxy endpoint; currently skipped until service exposure available.
- Execute via `npm run test:security`.

## OWASP ZAP Baseline

- CI job `dast` (optional) runs ZAP baseline against staging endpoint (`DAST_TARGET_URL`).
- Reports stored as artefacts (`dast-zap`).

## Usage

1. Start local stack (`docker compose up`).
2. Run `npm run test:fuzz` and `npm run test:security`.
3. Inspect failures and fix or harden endpoints.

## Coverage Goals

- All public POST endpoints should be fuzzed.
- SSRF tests should cover each outbound HTTP client with allowlist enforcement.
- Document new tests via PR updates to this guide.
*** End Patch
PATCH
