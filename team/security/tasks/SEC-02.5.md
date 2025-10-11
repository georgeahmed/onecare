Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-02.4.md) | [Next](SEC-02.6.md)

Task: SEC-02.5 — OIDC/JWT verification hardening

Context
- Hardening guidance for JWT verification (alg allowlist, aud/iss, nbf/exp skew, JWKs rotation) and tests alignment.

Files
- packages/security/src/index.ts (reference)
- docs/security/OIDC_JWT_HARDENING.md (new)

Steps
1) Document required checks: RS256/EdDSA only; verify `iss`/`aud` strictly; enforce `nbf`/`exp` with ±skew; reject none alg.
2) Define JWKs cache TTLs and rotation behavior on unknown kid; pin TLS; handle key revocation.
3) Add a test checklist for integrations to verify behavior (valid/expired/wrong aud/wrong iss/unknown kid then re-fetch).

Acceptance Criteria
- Hardening doc published; integration tests plan documented; owners assigned.

Validate
- Review with Integrations 01; align test cases.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.5' && make team-status-write

