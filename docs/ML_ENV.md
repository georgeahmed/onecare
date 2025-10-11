# ML Services Runtime Environment

This guide lists the environment variables and secrets required by the Python ML services (`safety_gate_service` and `scribe_service`). Populate real values from Vault-backed secrets; never commit populated `.env` files.

## Global toggles

| Variable | Description | Default |
| --- | --- | --- |
| `OTEL_ENABLED` | Enables lightweight OTEL-style logging/metrics (`1`/`true` to enable). | `0` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint if exporting real telemetry (optional for dev). | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP auth headers (e.g., `x-api-key=...`). | empty |
| `OTEL_RESOURCE_ATTRIBUTES` | Service/resource attributes (`service.name=...`). | varies |

Vault path: `kv/observability/otel/*`

## Safety Gate Service

| Variable | Description | Example / Notes |
| --- | --- | --- |
| `SAFETY_MODEL_PATH` | Filesystem path or URI for the triage model bundle. | `s3://onecare-ml/models/safety/latest` |
| `SAFETY_THRESHOLD` | Float threshold (0–1) for diverting red flags. | `0.65` |
| `SAFETY_RULESET_ID` | Optional ruleset identifier for feature flags. | `dev-default` |
| `SAFETY_MAX_TIMEOUT_MS` | Max latency budget per request. | `1500` |
| `SAFETY_SERVICE_API_KEY` | Downstream auth token when calling external services. | Vault secret |

Vault path: `kv/ml/safety-gate/*`

## Scribe Service (Ambient Documentation)

| Variable | Description | Example / Notes |
| --- | --- | --- |
| `SCRIBE_ASR_PROVIDER` | ASR provider slug (e.g., `whisper`, `deepgram`). | `whisper` |
| `SCRIBE_ASR_API_KEY` | API key for the ASR provider. | Vault secret |
| `SCRIBE_LLM_PROVIDER` | LLM provider slug (`openai`, `anthropic`, `azure-openai`). | `openai` |
| `SCRIBE_LLM_MODEL` | LLM model identifier. | `gpt-4o` |
| `SCRIBE_LLM_API_KEY` | API key/secret for LLM provider. | Vault secret |
| `SCRIBE_LLM_ENDPOINT` | Custom endpoint/base URL (if different from provider default). | `https://api.openai.com/v1` |
| `SCRIBE_REQUEST_TIMEOUT_MS` | Timeout when calling ASR/LLM endpoints. | `10000` |
| `SCRIBE_SUMMARY_MAX_TOKENS` | Max tokens in generated summaries. | `2048` |
| `SCRIBE_FALLBACK_MODE` | Behavior if LLM unavailable (`transcript`, `template`). | `transcript` |

Vault path: `kv/ml/scribe/*`

## Local development workflow

1. Copy `.env.example` to `.env.local`.
2. Retrieve required secrets from Vault (`vault kv get kv/ml/scribe/...`) and populate local values. Store the file securely; do not commit.
3. Use `OTEL_ENABLED=1` when debugging instrumentation locally; keep it disabled in tests to avoid noisy logs.
4. Restart Docker containers or local processes after changing env values.

## Secret handling checklist

- Store API keys in Vault + 1Password (temporary sharing).
- Rotate LLM/ASR keys every 60 days; document rotation in the security log.
- Ensure logs redact API keys, tokens, and request payloads that may contain PHI.
