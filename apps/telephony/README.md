Telephony Service

Purpose
- Cloud IVR integration, ASR transcript, intent classification, parity with portal flow.

State Flow
- CallReceived → LanguageSelection → Transcribed → IntentClassified → Routed

Privacy & Retention
- Audio uploads honour the `telephony.audio.retention_days` / `retention_seconds` settings from practice config. The object-store upload applies the TTL so recordings are purged automatically after the configured window (defaults to 30 days).
- The IVR in-memory spool is bounded (`50 MB` by default, configurable via `maxSpoolBytes`/`TELEPHONY_AUDIO_SPOOL_LIMIT_BYTES`). Calls that exceed the limit are aborted and the buffered audio is discarded to avoid unbounded PHI retention.
- For deployments that swap in a file-backed spool, operators should schedule secure erase with `scripts/ops/purge-dlq.sh --spool <path> --apply` after the retention window. The script truncates, shreds, and re-creates the spool directory so no residual audio remains.
