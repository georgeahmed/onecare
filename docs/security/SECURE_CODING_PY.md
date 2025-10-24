# Secure Coding Guidelines — Python / FastAPI

Last updated: 2025-10-18  
Owners: Security, ML Platform

## Input Validation

- Use Pydantic models for request bodies; enable `extra="forbid"` to reject unknown fields.
- Validate query parameters and headers explicitly. Use enums and constrained types.
- Sanitize file uploads; check MIME type and limit size.

## FastAPI & HTTP Responses

- Use response models to enforce output structure. Exclude sensitive fields by default.
- Return standardized error envelopes (HTTPException with detail mapping to `docs/ERRORS.md`).
- Set security headers (`Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`).

## Outbound Requests

- Use shared HTTP client with host allowlists and timeouts. Validate URLs, enforce HTTPS, and pin certificates where appropriate.
- Never allow user-supplied URLs without validation (SSRF). Use the orchestration helper for external calls.

## Secrets & Credentials

- Load secrets from environment (Vault-injected). Do not hard-code API keys.
- Use `python-dotenv` only for local development with `.env.local` outside version control.
- Rotate credentials per `SECRETS_POLICY.md`.

## Logging & Privacy

- Use structured logging (`structlog`/`logging`) with hashed identifiers. Exclude PHI from logs.
- Mask tokens and sensitive headers before logging.

## Error Handling

- Catch exceptions and map to safe HTTP responses; avoid exposing stack traces in production logs (`debug=False`).
- Wrap critical sections with try/except and ensure clean resource shutdown.

## File & Command Safety

- Avoid `eval`, `exec`, and shell command execution unless necessary. If required, use `subprocess` with explicit argument lists and sanitized inputs.
- Validate file paths to prevent directory traversal. Use temporary directories for untrusted input.

## Dependency Management

- Pin dependencies via `requirements-dev.txt`/`requirements.txt`. Run `pip-audit` regularly.
- Apply security patches promptly via Renovate/Dependabot.

## Testing & Tooling

- Write unit tests for validation, authentication flows, error handling.
- Run `pytest`, `ruff`, `black`, and security scans before merging.
- Address Semgrep/CodeQL findings related to Python.

## PR Checklist

- [ ] Request/response models updated; validators cover edge cases.
- [ ] Outbound HTTP calls use allowlisted hosts and timeouts.
- [ ] Logs redacted and no PHI included.
- [ ] Secrets fetched from env/Vault; no hardcoded credentials.
- [ ] Tests (pytest) updated; SAST flagged issues triaged.

Refer to the Secure SDLC policy (`docs/security/SECURE_SDLC.md`) for broader lifecycle requirements.
