Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | Prev: — | [Next](SEC-01.4.md)

Task: SEC-01.3 — CSP baseline and security headers policy

Context
- Define a Content Security Policy and security headers for frontend and proxies to reduce XSS and clickjacking risks.

Files
- docs/SECURITY_HEADERS.md (new)

Steps
1) Draft a CSP template (no inline scripts; script-src self and allowlists; upgrade-insecure-requests; frame-ancestors 'none').
2) Add recommended headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
3) Document how to apply via reverse proxy or app server and how to run in report-only mode first.

Implementation Notes
- `docs/SECURITY_HEADERS.md` now defines the baseline CSP, required headers, and deployment examples for NGINX and FastAPI.

Acceptance Criteria
- Policy documented; rollout guidance present.

Validate
- Local proxy config test with report-only CSP.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SEC-01.3' && make team-status-write
