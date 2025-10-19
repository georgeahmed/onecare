# ML Services Runtime Environment

This guide lists the environment variables and secrets required by the Python ML services (`safety_gate_service` and `scribe_service`) plus the orchestration endpoints that call them. Populate real values from Vault-backed secrets; never commit populated `.env` files.

## Global toggles

| Variable | Description | Default |
| --- | --- | --- |
| `OTEL_ENABLED` | Enables lightweight OTEL-style logging/metrics (`1`/`true` to enable). Safe to flip on locally for debugging. | `0` |
| `FEATURE_LOGGING` | Persist feature vectors to the configured FeatureStore via the orchestrator endpoint. | `0` |
| `FEATURE_DRIFT_MONITORING` | Enable live drift checks when feature logging is on. | `0` |
| `FEATURE_STORE_URL` | Postgres connection string for the feature store (used by purge job + local tooling). Configure per environment via secrets. | unset |
| `FEATURE_STORE_RETENTION_DAYS` | Optional override when running the purge script locally (days). | unset |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint if exporting real telemetry (optional for dev). | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP auth headers (e.g., `x-api-key=...`). | empty |
| `OTEL_RESOURCE_ATTRIBUTES` | Service/resource attributes (`service.name=...`). | varies |

Vault path: `kv/observability/otel/*`

## Service endpoints & ports

These values are shared between the Node orchestrator and the Python services. Defaults align with `docker-compose.yml`. Override per environment when deploying.

| Variable | Description | Default |
| --- | --- | --- |
| `PY_SAFETY_GATE_URL` | Base URL used by orchestrator to reach the safety gate container. | `http://safety-gate:8081` (compose) |
| `PY_SAFETY_GATE_HOST_ALLOWLIST` | Comma-separated hosts that bypass SSRF private-host blocking (e.g., `safety-gate` in Compose or `localhost,127.0.0.1` for local runs). | unset |
| `PY_SAFETY_GATE_API_KEY` | Bearer token attached to orchestrator → safety gate calls (prepends `Bearer ` when missing). | unset |
| `PY_SAFETY_GATE_AUTH_HEADER_NAME` / `PY_SAFETY_GATE_AUTH_HEADER_VALUE` | Optional custom auth header pair for safety gate calls (wins over bearer token). | unset |
| `PY_SAFETY_GATE_EXTRA_HEADERS` | JSON object of additional headers to apply to safety gate requests. | unset |
| `PY_SAFETY_GATE_MAX_RESPONSE_BYTES` | Hard cap on response size accepted from the safety gate (bytes). | `262144` |
| `PY_SCRIBE_URL` | Base URL used by orchestrator to reach the scribe container. | `http://scribe:8082` (compose) |
| `SAFETY_GATE_PORT` | Optional override for the Uvicorn port inside the safety gate container. | `8081` |
| `SCRIBE_PORT` | Optional override for the Uvicorn port inside the scribe container. | `8082` |
| `OTEL_ENABLED` | See table above—repeat here for clarity when injecting into container env. | `0` |
| `FEATURE_LOG_ENDPOINT` | HTTP endpoint that accepts feature log payloads (used by safety gate). | `http://orchestrator:3001/feature-log` |
| `FEATURE_LOG_AUTH_HEADER_NAME` / `FEATURE_LOG_AUTH_HEADER_VALUE` | Optional custom auth header pair for feature logging calls. | unset |
| `FEATURE_LOG_BEARER_TOKEN` | Bearer token for feature logging (ignored when custom header provided). | unset |
| `FEATURE_LOG_API_KEY` | Legacy token string for feature logging (sets `Authorization` directly). | unset |
| `FEATURE_LOG_EXTRA_HEADERS` | JSON object containing additional headers for feature logging. | unset |
| `FEATURE_LOG_RETRY_ATTEMPTS` | Max retry attempts for feature log delivery (exponential backoff). | `2` |
| `FEATURE_LOG_RETRY_BASE_MS` | Base delay (ms) for feature log retry backoff. | `150` |
| `FEATURE_DRIFT_BASELINE_SIZE` | Sample size for drift baseline window. | `200` |
| `FEATURE_DRIFT_CURRENT_SIZE` | Sample size for each evaluated window. | `50` |
| `FEATURE_DRIFT_PSI_THRESHOLD` | PSI threshold that emits a drift alert. | `0.5` |
| `FEATURE_DRIFT_MEAN_THRESHOLD` | Absolute mean delta that emits a drift alert. | `0.3` |
| `FEATURE_DRIFT_STD_THRESHOLD` | Absolute std-dev delta that emits a drift alert. | `0.3` |

Vault path: not required; values are non-secret but should be stored in environment management (ConfigMap/Parameter Store).

## Safety Gate Service

| Variable | Description | Example / Notes |
| --- | --- | --- |
| `SAFETY_MODEL_PATH` | Filesystem path or URI for the triage model bundle. | `s3://onecare-ml/models/safety/latest` |
| `SAFETY_THRESHOLD` | Float threshold (0–1) for diverting red flags. | `0.65` |
| `SAFETY_RULESET_ID` | Optional ruleset identifier for feature flags. | `dev-default` |
| `SAFETY_MAX_TIMEOUT_MS` | Max latency budget per request. | `1500` |
| `SAFETY_SERVICE_API_KEY` | Downstream auth token when calling external services. | Vault secret |
| `SAFETY_GATE_CLASSIFIER_MODE` | HuggingFace model slug for emergency classifier (`stub` uses heuristic). | `stub` |
| `SAFETY_GATE_MODEL_VERSION` | Logical classifier version key aligned with `config/safety_gate.yaml`. | `stub-v1` |
| `SAFETY_GATE_MODEL_VARIANT` | Optional A/B bucket (`control`, `high_precision`, etc.). | unset |
| `SAFETY_GATE_EMERGENCY_CONFIDENCE` | Overrides config threshold when set (0–1 float). | unset |
| `SAFETY_GATE_CONFIG_PATH` | Custom path to classifier threshold YAML (defaults to repo config). | unset |
| `SAFETY_GATE_NER_MODE` | `stub` keeps deterministic keyword NER; set to `hf` to use BioClinicalBERT pipeline. | `stub` (tests) |

Vault path: `kv/ml/safety-gate/*`

> Keep thresholds/calibration in sync with the offline evaluation harness (see task ML-01.19). Any new model promotion requires rerunning calibration on the protected validation set before editing `config/safety_gate.yaml`.

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
