# Secure Coding Guidelines — Node.js / TypeScript

Last updated: 2025-10-18  \
Owners: Security, Platform Engineering

## Input Validation

- Validate request bodies against JSON schemas (`zod`/generated validators). Reject unknown fields (`additionalProperties: false`).
- Normalize and sanitize query params, headers, and path variables.
- Enforce type safety; avoid casting to `any`.

## Output Handling

- Return error envelopes defined in `docs/ERRORS.md`. Do not leak stack traces or internal object dumps.
- Encode/escape user-provided data rendered in HTML (if applicable).

## HTTP Clients & SSRF

- Use shared HTTP client helpers with host allowlists. Validate URLs (scheme, host, port) against the allowlist; reject private/loopback addresses.
- Always set timeouts, retry budgets, and circuit breakers (see `callWithGuard` usage).
- Prefer HTTPS; pin certificates/SPKI for high-risk partners (see `TLS_POLICY.md`).

## Security Headers & Cookies

- Set `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy` on responses.
- Avoid storing tokens in cookies; if unavoidable, use `HttpOnly`, `Secure`, `SameSite=Strict`.

## Logging & Privacy

- Log structured JSON via `@onecare/observability`. Hash identifiers (`hashIdentifier`) and avoid PHI except hashed IDs.
- Use correlation IDs for tracing; never log raw access tokens or secrets.

## Error Handling

- Catch and map errors to safe codes. Ensure promises reject with typed errors; avoid unhandled rejections.
- Include context fields (correlationId, actor, service) without leaking PHI.

## Secrets & Configuration

- Read secrets from Vault-injected environment variables or files. No secrets in code, PRs, or logs.
- Respect feature flags and config schemas; update type definitions when adding new flags.

## Dependency Hygiene

- Use `npm ci` with locked dependencies. Monitor `npm audit` and Renovate PRs.
- Avoid dynamic `require` of untrusted modules.

## Testing & Tooling

- Add unit tests for validation, guardrails, and failure modes. Include negative tests (invalid JWT, SSRF attempts).
- Run lint (`npm run lint`) and typecheck before PR.
- SAST tools (Semgrep/CodeQL) run in CI; address flagged issues or document allowlisted justifications.

## PR Checklist

- [ ] Contracts/validators updated and regenerated.
- [ ] SSRF-safe HTTP helpers used (no raw `fetch` to user-provided URLs).
- [ ] Timeouts/retries/circuit breaker configured for outbound calls.
- [ ] Logging redacts PHI; error responses use standard envelopes.
- [ ] Secrets fetched from Vault/Env; no hard-coded credentials.
- [ ] SAST findings triaged; security review requested if needed.

Reference the Secure SDLC checklist (`docs/security/SECURE_SDLC.md`) before merging.
