# Logging Policy (Dev & Prod)

All services MUST emit structured JSON logs. The baseline schema is:

```jsonc
{
  "ts": "2025-10-11T20:12:34.567Z",   // ISO timestamp (UTC)
  "level": "info",                    // debug|info|warn|error
  "msg": "safety gate request started",
  "correlationId": "abc123",          // populated automatically when available
  "service": "orchestrator",          // optional: add when emitting
  "fields": "..."                     // key/value pairs; see redaction rules
}
```

## Requirements

- **JSON only**: one log event per line; no printf-style strings.
- **Correlation IDs**: every log MUST include `correlationId`. The shared logger in `@onecare/observability` injects it automatically when the OTEL context includes one.
- **Redaction**:
  - Avoid logging PHI/PII, secrets, or raw payloads.
  - Objects/arrays are traversed recursively; high-risk keys (`*Id`, `token`, `apiKey`, `sessionToken`, `email`, `phone`, transcripts, NHS / NI numbers, etc.) are replaced with `"[REDACTED]"`.
  - Header-like strings (`Authorization`, `Proxy-Authorization`, cookies) and embedded JSON fragments are scrubbed; Bearer/Basic tokens never reach the log sink.
  - Binary-like values (`Buffer`, `ArrayBuffer`, typed arrays) are always emitted as `"[REDACTED]"`.
  - The logger returns structured output with only safe primitives (string/number/boolean) so payloads stay machine-parsable.
  - Prefer explicit flags (`{ outcome: "SAFE_TO_CONTINUE" }`) over dumping request bodies.
- **Levels**:
  - `debug`: verbose diagnostics (disabled in prod).
  - `info`: key lifecycle events.
  - `warn`: recoverable issues (retry, fallback).
  - `error`: unrecoverable failures (surfaces in alerts).
- **Structured context**: pass a small set of primitives (string/number/boolean). Complex structures must be hashed or redacted first.

## Logger usage

```ts
import { logger } from '@onecare/observability';

logger.info('safety gate request started', { practiceId, channel: submission.channel });
logger.error('downstream timed out', { upstream: 'safety-gate', timeoutMs: 2000 });
```

When the request pipeline sets the correlation ID (via OTEL middleware), the logger ensures the emitted entry includes `correlationId`. Do not manually inject it unless you are logging outside the standard request flow (e.g., background jobs).

## Validation

Run services locally (`docker compose up`) and inspect logs:

```bash
docker compose logs orchestrator | jq .
```

Confirm:
- `ts`, `level`, `msg`, and `correlationId` are present.
- Sensitive payloads are not output.

## References

- [`packages/observability/src/logger.ts`](../../packages/observability/src/logger.ts)
- [`docs/observability/COLLECTOR.md`](./COLLECTOR.md)
