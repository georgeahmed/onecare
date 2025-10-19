Telephony Service

Purpose
- Cloud IVR integration, ASR transcript, intent classification, parity with portal flow.

State Flow
- CallReceived → LanguageSelection → Transcribed → IntentClassified → Routed

Privacy & Retention
- Audio uploads honour the `telephony.audio.retention_days` / `retention_seconds` settings from practice config. The object-store upload applies the TTL so recordings are purged automatically after the configured window (defaults to 30 days).
- The IVR in-memory spool is bounded (`50 MB` by default, configurable via `maxSpoolBytes`/`TELEPHONY_AUDIO_SPOOL_LIMIT_BYTES`). Calls that exceed the limit are aborted and the buffered audio is discarded to avoid unbounded PHI retention.
- For deployments that swap in a file-backed spool, operators should schedule secure erase with `scripts/ops/purge-dlq.sh --spool <path> --apply` after the retention window. The script truncates, shreds, and re-creates the spool directory so no residual audio remains.

Intent Classification Adapter
- `INTENT_SERVICE_URL` — HTTPS endpoint for the classifier. Must not resolve to private/loopback ranges.
- `INTENT_SERVICE_API_KEY` — shared secret sent via `x-api-key`; required when the service enforces auth.
- `INTENT_SERVICE_KEYWORD_INTENTS` — optional JSON array of keyword overrides used before making remote calls.
- `INTENT_SERVICE_TIMEOUT_MS` (default `2000`) — request timeout applied per attempt.
- `INTENT_SERVICE_MAX_RETRIES` (default `2`) — bounded retries for timeout/unavailable responses.
- `INTENT_SERVICE_BASE_DELAY_MS` / `INTENT_SERVICE_MAX_DELAY_MS` — exponential backoff window with jitter.
- `INTENT_SERVICE_HOST_ALLOWLIST` — comma-separated hostnames permitted for the adapter (defaults to the configured host).
- `INTENT_SERVICE_ALLOW_INSECURE_HTTP` — only enable for local development; production requires HTTPS.
- `INTENT_SERVICE_FALLBACK` — set to `stub` to enable keyword-based fallback when the remote service is unavailable.
