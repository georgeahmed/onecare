from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import math
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence
from uuid import uuid4
from urllib import error as urllib_error, request as urllib_request
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from common.contracts.models import PortalSubmission, SafetyDecision
from common.otel import instrument_fastapi
from common.security import AuthzContext, require_service_auth
from .acuity import AcuityModel
from .analyzer import AnalysisOutcome, analyze_submission
from .classifier import EmergencyClassifier
from .metrics import (
    get_golden_samples,
    record_batch_metrics,
    record_latency,
    record_prediction_metrics,
    record_request_outcome,
    record_overload,
    observe_request_latency,
    render_metrics,
    render_prometheus_metrics,
    update_queue_depth,
)
from .decision import DEFAULT_RED_FLAG_SET
from .ner import SafetyNER
from .predict import (
    PredictProbaResponse,
    PredictRequest,
    PredictResponse,
    predict_outcome,
    predict_proba,
)
from .shadow_eval import ShadowEvaluator
from .preprocess import NarrativeValidationError, validate_narrative
from .language import normalize_narrative
from .determinism import set_seed


LOGGER = logging.getLogger("safety_gate_service.main")
_CLASSIFIER: Optional[EmergencyClassifier] = None
_NER: Optional[SafetyNER] = None
_ACUITY_MODEL: Optional[AcuityModel] = None
_CLASSIFIER_LOCK = Lock()
_NER_LOCK = Lock()
_ACUITY_LOCK = Lock()
_DECISION_CONFIG: Optional[dict[str, Any]] = None
_DECISION_CONFIG_LOCK = Lock()
_FEATURE_LOG_ENDPOINT_ENV = "FEATURE_LOG_ENDPOINT"
_FEATURE_LOG_TIMEOUT = 0.5
_DEFAULT_LATENCY_SLO_MS = 800.0
_SENSITIVE_ID_KEYS = {"patientid", "entityid"}
_SENSITIVE_NAME_KEYS = {
    "patientname",
    "firstname",
    "lastname",
    "fullname",
    "displayname",
    "givenname",
    "familyname",
    "contactname",
}
_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+", re.IGNORECASE)
_PHONE_RE = re.compile(r"\b(?:\+?\d[\d\s\-]{7,}\d)\b")
_DIGIT_RE = re.compile(r"\b\d{6,}\b")
_FEATURE_LOG_SCOPE_HEADER = "analytics:feature:write"
_FEATURE_LOG_API_KEY_ENV = "FEATURE_LOG_API_KEY"
_LOG_SAMPLE_RATE_ENV = "SAFETY_GATE_LOG_SAMPLE_RATE"
_ENVIRONMENT_ENV_VARS = ("ENVIRONMENT", "DEPLOY_ENV", "APP_ENV", "NODE_ENV")
_PROD_ENV_VALUES = {"prod", "production"}
_BATCH_ENABLE_ENV = "SAFETY_GATE_ENABLE_BATCHING"
_BATCH_MAX_SIZE_ENV = "SAFETY_GATE_BATCH_MAX_SIZE"
_BATCH_TIMEOUT_ENV = "SAFETY_GATE_BATCH_TIMEOUT_MS"
_DEVICE_ENV = "SAFETY_GATE_DEVICE"
_QUANTIZATION_ENV = "SAFETY_GATE_ENABLE_QUANTIZATION"
_MODEL_MAX_BYTES_ENV = "SAFETY_GATE_MAX_MODEL_BYTES"
_DEFAULT_BATCH_TIMEOUT_MS = 25
_MAX_REQUEST_BYTES_ENV = "SAFETY_GATE_MAX_REQUEST_BYTES"
_DEFAULT_MAX_REQUEST_BYTES = 64 * 1024
_GUARDED_JSON_PATHS = {"/analyze", "/predict", "/predict_proba"}
_MAX_CONCURRENCY_ENV = "SAFETY_GATE_MAX_CONCURRENCY"
_QUEUE_MAX_ENV = "SAFETY_GATE_MAX_QUEUE"
_QUEUE_TIMEOUT_ENV = "SAFETY_GATE_QUEUE_TIMEOUT_MS"
_DEFAULT_MAX_CONCURRENCY = 4
_DEFAULT_QUEUE_MAX = 32
_DEFAULT_QUEUE_TIMEOUT_MS = 1000


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value


@dataclass(frozen=True)
class PerformanceSettings:
    enable_batching: bool
    batch_max_size: int
    batch_timeout_ms: int
    device: str
    enable_quantization: bool
    max_model_bytes: int
    max_concurrency: int
    max_queue: int
    queue_timeout_ms: int


def _load_performance_settings() -> PerformanceSettings:
    enable_batching = _env_flag(_BATCH_ENABLE_ENV, default=False)
    batch_max_size = max(1, _env_int(_BATCH_MAX_SIZE_ENV, default=4))
    batch_timeout_ms = max(1, _env_int(_BATCH_TIMEOUT_ENV, default=_DEFAULT_BATCH_TIMEOUT_MS))
    device = os.getenv(_DEVICE_ENV, "cpu").strip().lower() or "cpu"
    if device not in {"cpu", "cuda"}:
        LOGGER.debug("Unsupported device '%s'; defaulting to cpu", device)
        device = "cpu"
    enable_quantization = _env_flag(_QUANTIZATION_ENV, default=False)
    max_model_bytes = max(0, _env_int(_MODEL_MAX_BYTES_ENV, default=0))
    max_concurrency = max(1, _env_int(_MAX_CONCURRENCY_ENV, default=_DEFAULT_MAX_CONCURRENCY))
    max_queue = max(0, _env_int(_QUEUE_MAX_ENV, default=_DEFAULT_QUEUE_MAX))
    queue_timeout_ms = max(1, _env_int(_QUEUE_TIMEOUT_ENV, default=_DEFAULT_QUEUE_TIMEOUT_MS))
    return PerformanceSettings(
        enable_batching=enable_batching,
        batch_max_size=batch_max_size,
        batch_timeout_ms=batch_timeout_ms,
        device=device,
        enable_quantization=enable_quantization,
        max_model_bytes=max_model_bytes,
        max_concurrency=max_concurrency,
        max_queue=max_queue,
        queue_timeout_ms=queue_timeout_ms,
    )


def _max_request_bytes() -> int:
    return max(0, _env_int(_MAX_REQUEST_BYTES_ENV, default=_DEFAULT_MAX_REQUEST_BYTES))


def _is_json_content_type(value: Optional[str]) -> bool:
    if not value:
        return False
    media_type = value.split(";")[0].strip().lower()
    return media_type == "application/json"


def _error_response(
    status_code: int,
    *,
    code: str,
    message: str,
    correlation_id: str,
    details: Optional[Any] = None,
    headers: Optional[Mapping[str, str]] = None,
) -> JSONResponse:
    envelope: dict[str, Any] = {
        "error": {
            "code": code,
            "message": message,
            "correlationId": correlation_id,
        }
    }
    if details is not None:
        envelope["error"]["details"] = details
    response = JSONResponse(status_code=status_code, content=envelope)
    response.headers["x-correlation-id"] = correlation_id
    if headers:
        for key, value in headers.items():
            response.headers[key] = value
    return response


class BatchProcessor:
    def __init__(
        self,
        *,
        enabled: bool,
        max_batch_size: int,
        batch_timeout_ms: int,
    ) -> None:
        self._enabled = enabled
        self._max_batch_size = max(1, max_batch_size)
        self._batch_timeout = max(1, batch_timeout_ms) / 1000.0
        self._lock = asyncio.Lock()
        self._queue: list[tuple[Callable[[], Awaitable[Any]], asyncio.Future[Any]]] = []
        self._timer_handle: Optional[asyncio.TimerHandle] = None
        self._processing = False
        self.last_batch_size = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def submit(self, task_factory: Callable[[], Awaitable[Any]]) -> Any:
        if not self._enabled:
            return await task_factory()

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        to_process: Optional[list[tuple[Callable[[], Awaitable[Any]], asyncio.Future[Any]]]] = None

        async with self._lock:
            self._queue.append((task_factory, future))
            if len(self._queue) >= self._max_batch_size:
                to_process = self._drain_queue_locked()
            elif self._timer_handle is None:
                self._timer_handle = loop.call_later(self._batch_timeout, self._schedule_timeout_flush)

        if to_process is not None:
            await self._process_batch(to_process)

        return await future

    def _schedule_timeout_flush(self) -> None:
        asyncio.create_task(self._timeout_flush())

    async def _timeout_flush(self) -> None:
        to_process: Optional[list[tuple[Callable[[], Awaitable[Any]], asyncio.Future[Any]]]] = None
        async with self._lock:
            if not self._queue:
                self._cancel_timer_locked()
                return
            to_process = self._drain_queue_locked()
        if to_process is not None:
            await self._process_batch(to_process)

    def _drain_queue_locked(self) -> list[tuple[Callable[[], Awaitable[Any]], asyncio.Future[Any]]]:
        items = self._queue
        self._queue = []
        self._cancel_timer_locked()
        return items

    def _cancel_timer_locked(self) -> None:
        handle = self._timer_handle
        if handle is not None:
            handle.cancel()
        self._timer_handle = None

    async def _process_batch(
        self,
        batch: list[tuple[Callable[[], Awaitable[Any]], asyncio.Future[Any]]],
    ) -> None:
        if not batch:
            return
        while self._processing:
            await asyncio.sleep(0)
        self._processing = True
        self.last_batch_size = len(batch)
        record_batch_metrics(len(batch))
        try:
            for factory, future in batch:
                if future.cancelled():
                    continue
                try:
                    result = await factory()
                except Exception as exc:  # pragma: no cover - propagated to caller
                    if not future.cancelled():
                        future.set_exception(exc)
                else:
                    if not future.cancelled():
                        future.set_result(result)
        finally:
            self._processing = False


class ConcurrencyLimiter:
    def __init__(
        self,
        *,
        max_concurrency: int,
        max_queue: int,
        wait_timeout_ms: int,
    ) -> None:
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self._max_queue = max_queue
        self._wait_timeout = max(0, wait_timeout_ms) / 1000.0
        self._waiting = 0
        self._lock = asyncio.Lock()
        update_queue_depth(0)

    async def acquire(self) -> Optional[str]:
        acquired = False
        queued = False
        if self._semaphore.locked() and self._max_queue >= 0:
            async with self._lock:
                if self._waiting >= self._max_queue:
                    record_overload("queue")
                    return "queue"
                self._waiting += 1
                update_queue_depth(self._waiting)
                queued = True
        try:
            await asyncio.wait_for(
                self._semaphore.acquire(),
                timeout=self._wait_timeout if self._wait_timeout > 0 else None,
            )
            acquired = True
        except asyncio.TimeoutError:
            if queued:
                async with self._lock:
                    self._waiting = max(0, self._waiting - 1)
                    update_queue_depth(self._waiting)
            record_overload("timeout")
            return "timeout"
        finally:
            if queued and not acquired:
                async with self._lock:
                    self._waiting = max(0, self._waiting - 1)
                    update_queue_depth(self._waiting)
        if queued and acquired:
            async with self._lock:
                self._waiting = max(0, self._waiting - 1)
                update_queue_depth(self._waiting)
        return None

    def release(self) -> None:
        self._semaphore.release()
        update_queue_depth(self._waiting)


_ANALYZE_AUTH = require_service_auth(env_var="SAFETY_GATE_API_KEY", required_scope="safety:analyze")
_PREDICT_AUTH = require_service_auth(env_var="SAFETY_GATE_API_KEY", required_scope="safety:predict")


def _extract_correlation_id(request: Request) -> str:
    state_value = getattr(request.state, "correlation_id", None)
    if isinstance(state_value, str) and state_value.strip():
        return state_value.strip()
    header = request.headers.get("x-correlation-id") or request.headers.get("x-request-id")
    return header or str(uuid4())


def _attach_correlation_headers(response: Response, correlation_id: str, consent_reference: Optional[str] = None) -> None:
    response.headers["x-correlation-id"] = correlation_id
    if consent_reference and isinstance(consent_reference, str) and consent_reference.strip():
        response.headers["x-consent-reference"] = consent_reference


def _feature_logging_enabled() -> bool:
    value = os.getenv("FEATURE_LOGGING", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _feature_log_endpoint() -> Optional[str]:
    candidate = os.getenv(_FEATURE_LOG_ENDPOINT_ENV, "http://orchestrator:3001/feature-log")
    trimmed = candidate.strip()
    if not trimmed:
        return None
    parsed = urlparse(trimmed)
    if parsed.scheme not in {"http", "https"}:
        LOGGER.debug("Ignoring feature log endpoint with invalid scheme: %s", trimmed)
        return None
    if not parsed.netloc:
        LOGGER.debug("Ignoring feature log endpoint without host: %s", trimmed)
        return None
    if parsed.username or parsed.password:
        LOGGER.debug("Ignoring feature log endpoint with credentials: %s", trimmed)
        return None
    return trimmed


def _feature_log_api_key() -> Optional[str]:
    candidate = os.getenv(_FEATURE_LOG_API_KEY_ENV, "")
    trimmed = candidate.strip()
    return trimmed or None


def _clamp_rate(value: Any) -> float:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(rate):
        return 0.0
    if rate < 0:
        return 0.0
    if rate > 1:
        return 1.0
    return rate


def _effective_log_sample_rate(config: Mapping[str, Any] | None) -> float:
    override = os.getenv(_LOG_SAMPLE_RATE_ENV)
    if override is not None:
        return _clamp_rate(override)
    if isinstance(config, Mapping):
        for candidate_key in ("request_log_sample_rate", "log_sample_rate"):
            if candidate_key in config:
                return _clamp_rate(config.get(candidate_key))
    return 0.0


def _current_environment() -> str:
    for env_key in _ENVIRONMENT_ENV_VARS:
        value = os.getenv(env_key)
        if value and value.strip():
            return value.strip().lower()
    return "dev"


def _should_sample_request_logs(config: Mapping[str, Any] | None, *, sample: Optional[float] = None) -> bool:
    if _current_environment() in _PROD_ENV_VALUES:
        return False
    rate = _effective_log_sample_rate(config)
    if rate <= 0:
        return False
    draw = random.random() if sample is None else sample
    return draw <= rate


def _emit_feature_log(payload: dict[str, Any], consent_reference: Optional[str]) -> None:
    if not _feature_logging_enabled():
        return

    endpoint = _feature_log_endpoint()
    if not endpoint:
        return

    api_key = _feature_log_api_key()
    if not api_key:
        LOGGER.debug("Feature logging skipped: API key missing")
        return

    try:
        data = json.dumps(payload, default=str).encode("utf-8")
    except (TypeError, ValueError) as exc:  # pragma: no cover - serialization guard
        LOGGER.debug("Failed to serialize feature payload: %s", exc)
        return

    request_obj = urllib_request.Request(
        endpoint,
        data=data,
        headers=_feature_log_headers(payload.get("correlationId"), consent_reference, api_key),
        method="POST",
    )
    attempts, base_delay = _feature_log_retry_policy()
    for attempt in range(1, attempts + 1):
        try:
            urllib_request.urlopen(request_obj, timeout=_FEATURE_LOG_TIMEOUT)
            return
        except Exception as exc:  # pragma: no cover - network guards
            retryable = attempt < attempts and _should_retry_feature_log(exc)
            LOGGER.debug(
                "Feature logging request failed (attempt %s/%s, retryable=%s): %s",
                attempt,
                attempts,
                retryable,
                getattr(exc, "reason", exc),
            )
            if not retryable:
                break
            delay = _compute_retry_delay(base_delay, attempt)
            _feature_log_sleep(delay)


def _feature_log_headers(
    correlation_id: Optional[str],
    consent_reference: Optional[str],
    api_key: str,
) -> dict[str, str]:
    headers: dict[str, str] = {
        "content-type": "application/json",
        "x-api-key": api_key,
    }
    if correlation_id and isinstance(correlation_id, str) and correlation_id.strip():
        headers["x-correlation-id"] = correlation_id.strip()
    if consent_reference and isinstance(consent_reference, str) and consent_reference.strip():
        headers["x-consent-reference"] = consent_reference.strip()
    headers.update(_feature_log_auth_headers())
    headers.setdefault("x-auth-scope", _FEATURE_LOG_SCOPE_HEADER)
    return headers


def _feature_log_auth_headers() -> dict[str, str]:
    headers: dict[str, str] = {}
    name = os.getenv("FEATURE_LOG_AUTH_HEADER_NAME", "").strip()
    value = os.getenv("FEATURE_LOG_AUTH_HEADER_VALUE", "").strip()
    if name and value:
        headers[name] = value

    bearer = (os.getenv("FEATURE_LOG_BEARER_TOKEN") or os.getenv("FEATURE_LOG_AUTH_TOKEN") or "").strip()
    if bearer and all(key.lower() != "authorization" for key in headers):
        if bearer.lower().startswith("bearer "):
            headers["Authorization"] = bearer
        else:
            headers["Authorization"] = f"Bearer {bearer}"

    extras = os.getenv("FEATURE_LOG_EXTRA_HEADERS")
    if extras:
        try:
            parsed = json.loads(extras)
            if isinstance(parsed, dict):
                for key, extra_value in parsed.items():
                    if isinstance(key, str) and isinstance(extra_value, str) and key.strip() and extra_value.strip():
                        headers[key] = extra_value
        except (TypeError, ValueError):
            LOGGER.debug("Ignored malformed FEATURE_LOG_EXTRA_HEADERS payload")

    return headers


def _feature_log_retry_policy() -> tuple[int, float]:
    raw_attempts = os.getenv("FEATURE_LOG_RETRY_ATTEMPTS")
    try:
        attempts = int(raw_attempts) if raw_attempts is not None else 2
    except ValueError:
        attempts = 2
    attempts = max(1, min(attempts, 5))

    raw_base = os.getenv("FEATURE_LOG_RETRY_BASE_MS")
    try:
        base_ms = float(raw_base) if raw_base is not None else 150.0
    except ValueError:
        base_ms = 150.0
    base_ms = max(0.0, min(base_ms, 2000.0))
    return attempts, base_ms / 1000.0


def _should_retry_feature_log(exc: Exception) -> bool:
    if isinstance(exc, urllib_error.HTTPError):
        code = getattr(exc, "code", 0)
        return 500 <= (code or 0) < 600
    if isinstance(exc, urllib_error.URLError):
        return True
    return False


def _compute_retry_delay(base_delay: float, attempt: int) -> float:
    if base_delay <= 0:
        return 0.0
    delay = base_delay * (2 ** (attempt - 1))
    jitter = delay * 0.25 * random.random()
    return delay + jitter


def _feature_log_sleep(seconds: float) -> None:
    if seconds <= 0:
        return
    time.sleep(seconds)


def _log_safety_features(
    *,
    submission: PortalSubmission,
    correlation_id: Optional[str],
    classification: Mapping[str, Any],
    nlp_payload: Mapping[str, Any],
    decision_result,
    lexical_hits: list[str],
    consent_reference: Optional[str],
) -> None:
    feature_packet: dict[str, Any] = {
        "classifier": {
            "probEmergency": classification.get("prob_emergency"),
            "threshold": classification.get("threshold"),
            "modelVersion": classification.get("model_version"),
            "isEmergency": classification.get("is_emergency"),
        },
        "nlp": {
            "symptomMentions": nlp_payload.get("symptom_mentions", []),
            "redFlagHits": lexical_hits,
            "severity": nlp_payload.get("severity", []),
            "temporal": nlp_payload.get("temporal", []),
        },
        "decision": {
            "outcome": decision_result.outcome,
            "reason": decision_result.rationale.get("reason"),
            "signals": decision_result.rationale.get("signals"),
        },
    }

    feature_packet = _sanitize_payload(feature_packet)

    sanitized_metadata = _sanitize_payload(
        {
            "practiceId": submission.practiceId,
            "channel": submission.channel,
            "analysisId": str(uuid4()),
            "recordedAt": datetime.now(timezone.utc).isoformat(),
            "consentReference": consent_reference,
        }
    )

    patient_identifiers = _sanitize_payload(
        {
            "entityId": submission.patient.id,
            "patientId": submission.patient.id,
        }
    )

    payload = {
        "source": "safety",
        "entityId": patient_identifiers.get("entityId"),
        "patientId": patient_identifiers.get("patientId"),
        "correlationId": correlation_id,
        "features": feature_packet,
        "metadata": sanitized_metadata,
    }

    _emit_feature_log(payload, consent_reference)


def _log_request_summary(
    *,
    submission: PortalSubmission,
    correlation_id: str,
    outcome: AnalysisOutcome,
    probability: Optional[float],
    latency_ms: float,
    latency_snapshot: Mapping[str, Optional[float]],
    classification: Mapping[str, Any] | None,
    red_flags: Sequence[Any],
    consent_reference: Optional[str],
    language_code: Optional[str] = None,
    translated: bool = False,
) -> None:
    classifier_version = None
    classifier_threshold = None
    if isinstance(classification, Mapping):
        classifier_version = classification.get("model_version") or classification.get("version")
        classifier_threshold = classification.get("threshold")

    sanitized_flags = [_redact_pii(str(flag)) for flag in red_flags if isinstance(flag, str)]
    narrative_word_count = len([word for word in (submission.narrative or "").split() if word])
    summary = {
        "practiceId": submission.practiceId,
        "channel": submission.channel.value if hasattr(submission.channel, "value") else submission.channel,
        "decision": outcome.decision.outcome,
        "probEmergency": probability,
        "classifier": {
            "modelVersion": classifier_version,
            "threshold": classifier_threshold,
        },
        "latencyMs": round(latency_ms, 2),
        "latencyP50Ms": latency_snapshot.get("p50"),
        "latencyP95Ms": latency_snapshot.get("p95"),
        "redFlagCount": len(sanitized_flags),
        "redFlags": sanitized_flags[:5],
        "narrativeWordCount": narrative_word_count,
        "hasConsentReference": bool(consent_reference),
    }
    if language_code:
        summary["language"] = language_code
        summary["languageTranslated"] = translated
    LOGGER.info(
        "safety_gate.analyze.summary correlation_id=%s details=%s",
        correlation_id,
        _sanitize_payload(summary),
    )


def _compute_model_metadata(
    classifier: EmergencyClassifier,
    ner: SafetyNER,
    acuity_model: AcuityModel,
) -> dict[str, Any]:
    classifier_version = getattr(classifier, "_model_version", None)
    acuity_version = getattr(acuity_model, "_model_version", None)
    ner_model_name = getattr(ner, "_model_name", None)
    ner_mode = "stub" if getattr(ner, "_use_stub", False) else "full"
    fingerprint_source = "|".join(
        str(part)
        for part in (classifier_version, acuity_version, ner_model_name, ner_mode)
        if part
    )
    model_hash = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()[:12] if fingerprint_source else None
    return {
        "classifierVersion": classifier_version,
        "acuityVersion": acuity_version,
        "nerModel": ner_model_name,
        "nerMode": ner_mode,
        "modelHash": model_hash,
    }


def _warmup_models(
    classifier: EmergencyClassifier,
    ner: SafetyNER,
    acuity_model: AcuityModel,
) -> float:
    start = time.perf_counter()
    narrative = "patient reports mild headache"
    try:
        nlp_payload = ner.analyze(narrative)
    except Exception as exc:  # pragma: no cover - warmup fallback path
        LOGGER.debug("Warmup NER failed: %s", exc, exc_info=False)
        nlp_payload = {"symptom_mentions": [], "red_flag_hits": []}

    try:
        classifier_result = classifier.classify(narrative)
    except Exception as exc:  # pragma: no cover - warmup fallback path
        LOGGER.debug("Warmup classifier failed: %s", exc, exc_info=False)
        classifier_result = {"prob_emergency": 0.0}

    try:
        acuity_model.predict(
            narrative=narrative,
            nlp_results=nlp_payload,
            classifier_result=classifier_result,
        )
    except Exception as exc:  # pragma: no cover - warmup fallback path
        LOGGER.debug("Warmup acuity failed: %s", exc, exc_info=False)

    return (time.perf_counter() - start) * 1000.0


def get_classifier(force_reload: bool = False) -> EmergencyClassifier:
    global _CLASSIFIER

    if force_reload:
        with _CLASSIFIER_LOCK:
            LOGGER.debug("Reloading EmergencyClassifier instance (force_reload=True)")
            _CLASSIFIER = EmergencyClassifier()
            return _CLASSIFIER

    if _CLASSIFIER is None:
        with _CLASSIFIER_LOCK:
            if _CLASSIFIER is None:
                LOGGER.debug("Initializing EmergencyClassifier instance")
                _CLASSIFIER = EmergencyClassifier()
    return _CLASSIFIER


def get_ner(force_reload: bool = False) -> SafetyNER:
    global _NER

    if force_reload:
        with _NER_LOCK:
            LOGGER.debug("Reloading SafetyNER instance (force_reload=True)")
            _NER = SafetyNER()
            return _NER

    if _NER is None:
        with _NER_LOCK:
            if _NER is None:
                LOGGER.debug("Initializing SafetyNER instance")
                _NER = SafetyNER()
    return _NER


def get_acuity_model(force_reload: bool = False) -> AcuityModel:
    global _ACUITY_MODEL

    if force_reload:
        with _ACUITY_LOCK:
            LOGGER.debug("Reloading AcuityModel instance (force_reload=True)")
            _ACUITY_MODEL = AcuityModel()
            return _ACUITY_MODEL

    if _ACUITY_MODEL is None:
        with _ACUITY_LOCK:
            if _ACUITY_MODEL is None:
                LOGGER.debug("Initializing AcuityModel instance")
                _ACUITY_MODEL = AcuityModel()
    return _ACUITY_MODEL


def get_decision_config(force_reload: bool = False) -> dict[str, Any]:
    global _DECISION_CONFIG

    if force_reload:
        with _DECISION_CONFIG_LOCK:
            LOGGER.debug("Reloading decision configuration (force_reload=True)")
            _DECISION_CONFIG = _load_decision_config()
            return _DECISION_CONFIG

    if _DECISION_CONFIG is None:
        with _DECISION_CONFIG_LOCK:
            if _DECISION_CONFIG is None:
                LOGGER.debug("Loading decision configuration")
                _DECISION_CONFIG = _load_decision_config()
    return _DECISION_CONFIG


def _load_decision_config() -> dict[str, Any]:
    base_config: dict[str, Any] = {
        "red_flag_threshold": 0.65,
        "red_flag_set": list(DEFAULT_RED_FLAG_SET),
        "emergency_confidence": 0.72,
        "acuity_threshold_emergency": 0.75,
        "timeout_ms": 800,
        "fallback": "rules",
        "log_sample_rate": 0.1,
        "latency_slo_p95_ms": _DEFAULT_LATENCY_SLO_MS,
    }

    root = Path(__file__).resolve().parents[2]
    global_config_path = root / "config" / "global.yaml"

    try:
        import yaml  # type: ignore
    except ImportError:
        LOGGER.warning("PyYAML not installed; decision config falls back to defaults")
        return base_config

    parsed: dict[str, Any] | None = None
    if global_config_path.exists():
        try:
            with global_config_path.open(encoding="utf-8") as handle:
                loaded = yaml.safe_load(handle) or {}
                if isinstance(loaded, dict):
                    parsed = loaded
        except Exception as exc:
            LOGGER.warning("Failed to parse %s: %s", global_config_path, exc)

    if not parsed:
        return base_config

    red_flag_set = parsed.get("red_flag_set")
    if isinstance(red_flag_set, list) and red_flag_set:
        merged: list[str] = list(base_config["red_flag_set"])
        for item in red_flag_set:
            if isinstance(item, str) and item not in merged:
                merged.append(item)
        base_config["red_flag_set"] = merged

    safety_gate_cfg = parsed.get("safety_gate")
    if isinstance(safety_gate_cfg, dict):
        for key in (
            "red_flag_threshold",
            "emergency_confidence",
            "acuity_threshold_emergency",
            "timeout_ms",
            "fallback",
            "log_sample_rate",
            "latency_slo_p95_ms",
        ):
            if key in safety_gate_cfg:
                base_config[key] = safety_gate_cfg[key]

    return base_config


def reset_models_for_testing() -> None:
    """Reset cached models so tests can reconfigure env thresholds."""

    global _CLASSIFIER
    global _NER
    global _ACUITY_MODEL
    global _DECISION_CONFIG
    with _CLASSIFIER_LOCK:
        _CLASSIFIER = None
    with _NER_LOCK:
        _NER = None
    with _ACUITY_LOCK:
        _ACUITY_MODEL = None
    with _DECISION_CONFIG_LOCK:
        _DECISION_CONFIG = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.model_ready = False
    app.state.model_metadata = {}
    app.state.performance = _load_performance_settings()
    seed_value = set_seed(os.getenv("SAFETY_GATE_SEED"))
    LOGGER.info("safety_gate.seed configured seed=%s", seed_value)
    load_start = time.perf_counter()
    try:
        classifier = get_classifier()
        ner = get_ner()
        acuity_model = get_acuity_model()
        decision_config = get_decision_config()
        performance_settings: PerformanceSettings = app.state.performance
        if performance_settings.enable_batching:
            app.state.batch_processor = BatchProcessor(
                enabled=True,
                max_batch_size=performance_settings.batch_max_size,
                batch_timeout_ms=performance_settings.batch_timeout_ms,
            )
        else:
            app.state.batch_processor = None
        app.state.concurrency_limiter = ConcurrencyLimiter(
            max_concurrency=performance_settings.max_concurrency,
            max_queue=performance_settings.max_queue,
            wait_timeout_ms=performance_settings.queue_timeout_ms,
        )
        load_ms = (time.perf_counter() - load_start) * 1000.0
        warmup_ms = _warmup_models(classifier, ner, acuity_model)
        metadata = _compute_model_metadata(classifier, ner, acuity_model)
        metadata.update(
            {
                "batching": {
                    "enabled": performance_settings.enable_batching,
                    "maxSize": performance_settings.batch_max_size,
                    "timeoutMs": performance_settings.batch_timeout_ms,
                },
                "maxConcurrency": performance_settings.max_concurrency,
                "maxQueue": performance_settings.max_queue,
            }
        )
        metadata.update(
            {
                "loadMs": load_ms,
                "warmupMs": warmup_ms,
                "readyAt": datetime.now(timezone.utc).isoformat(),
            }
        )
        app.state.classifier = classifier
        app.state.ner = ner
        app.state.acuity_model = acuity_model
        app.state.decision_config = decision_config
        app.state.model_metadata = metadata
        LOGGER.info(
            "safety_gate.startup.models_ready load_ms=%.2f warmup_ms=%.2f model_hash=%s classifier_version=%s acuity_version=%s ner_model=%s",
            load_ms,
            warmup_ms,
            metadata.get("modelHash"),
            metadata.get("classifierVersion"),
            metadata.get("acuityVersion"),
            metadata.get("nerModel"),
        )
    except Exception as exc:  # pragma: no cover - startup failure path
        LOGGER.exception("Failed to initialize EmergencyClassifier: %s", exc)
        raise
    app.state.model_ready = True
    app.state.shadow_evaluator = None
    try:
        yield
    finally:
        app.state.model_ready = False
        app.state.classifier = None
        app.state.ner = None
        app.state.acuity_model = None
        app.state.decision_config = None
        app.state.shadow_evaluator = None
        app.state.model_metadata = {}
        app.state.batch_processor = None
        app.state.concurrency_limiter = None


app = FastAPI(title="Safety Gate Service", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.middleware("http")
async def _ingress_guard(request: Request, call_next: Callable[..., Awaitable[Response]]) -> Response:
    correlation_id = _extract_correlation_id(request)
    request.state.correlation_id = correlation_id
    try:
        if request.method in {"POST", "PUT"} and request.url.path in _GUARDED_JSON_PATHS:
            if not _is_json_content_type(request.headers.get("content-type")):
                return _error_response(
                    415,
                    code="unsupported_media_type",
                    message="Content-Type must be application/json",
                    correlation_id=correlation_id,
                )
            max_bytes = _max_request_bytes()
            if max_bytes > 0:
                header_value = request.headers.get("content-length")
                if header_value:
                    try:
                        content_length = int(header_value)
                    except ValueError:
                        return _error_response(
                            400,
                            code="invalid_content_length",
                            message="Invalid Content-Length header",
                            correlation_id=correlation_id,
                        )
                    if content_length > max_bytes:
                        return _error_response(
                            413,
                            code="payload_too_large",
                            message="Request body exceeds size limit",
                            correlation_id=correlation_id,
                        )
                else:
                    body = await request.body()
                    if len(body) > max_bytes:
                        return _error_response(
                            413,
                            code="payload_too_large",
                            message="Request body exceeds size limit",
                            correlation_id=correlation_id,
                        )
                    request._body = body
        response = await call_next(request)
    except HTTPException as exc:
        status = exc.status_code or 500
        detail = exc.detail
        if isinstance(detail, Mapping) and "error" in detail:
            error_node = detail["error"]
            if isinstance(error_node, Mapping):
                return _error_response(
                    status,
                    code=str(error_node.get("code") or "error"),
                    message=str(error_node.get("message") or "Request failed"),
                    correlation_id=correlation_id,
                    details=error_node.get("details"),
                    headers=getattr(exc, "headers", None),
                )
        message = detail if isinstance(detail, str) else "Request failed"
        return _error_response(
            status,
            code="error",
            message=message,
            correlation_id=correlation_id,
            details=detail if isinstance(detail, Mapping) else None,
            headers=getattr(exc, "headers", None),
        )
    except Exception:
        LOGGER.exception("safety_gate.unhandled_error correlation_id=%s", correlation_id)
        return _error_response(
            500,
            code="internal_error",
            message="Internal server error",
            correlation_id=correlation_id,
        )

    response.headers.setdefault("x-correlation-id", correlation_id)
    return response


@app.exception_handler(RequestValidationError)
async def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    correlation_id = _extract_correlation_id(request)
    LOGGER.info("safety_gate.validation_error correlation_id=%s", correlation_id)
    return _error_response(
        400,
        code="invalid_input",
        message="Invalid request payload",
        details={"errors": exc.errors()},
        correlation_id=correlation_id,
    )


@app.get("/health")
def health(request: Request, response: Response) -> dict[str, Any]:
    correlation_id = _extract_correlation_id(request)
    _attach_correlation_headers(response, correlation_id)
    metadata = getattr(app.state, "model_metadata", {}) or {}
    return {
        "status": "ok",
        "version": app.version,
        "modelHash": metadata.get("modelHash"),
    }


@app.get("/ready")
def ready(request: Request, response: Response) -> dict[str, Any]:
    correlation_id = _extract_correlation_id(request)
    _attach_correlation_headers(response, correlation_id)
    metadata = getattr(app.state, "model_metadata", {}) or {}
    body = {
        "version": app.version,
        "modelHash": metadata.get("modelHash"),
        "classifierVersion": metadata.get("classifierVersion"),
        "acuityVersion": metadata.get("acuityVersion"),
        "nerModel": metadata.get("nerModel"),
        "loadMs": metadata.get("loadMs"),
        "warmupMs": metadata.get("warmupMs"),
    }
    batching_info = metadata.get("batching")
    if isinstance(batching_info, Mapping):
        body["batching"] = batching_info
    if "maxConcurrency" in metadata:
        body["maxConcurrency"] = metadata.get("maxConcurrency")
    if "maxQueue" in metadata:
        body["maxQueue"] = metadata.get("maxQueue")
    if getattr(app.state, "model_ready", False):
        body["status"] = "ready"
        return body
    response.status_code = 503
    body["status"] = "warming"
    return body


@app.post("/analyze", response_model=SafetyDecision)
async def analyze(
    request: Request,
    submission: PortalSubmission,
    response: Response,
    auth: AuthzContext = Depends(_ANALYZE_AUTH),
) -> SafetyDecision:
    correlation_id = _extract_correlation_id(request)
    _attach_correlation_headers(response, correlation_id, auth.consent_reference)
    try:
        submission.narrative = validate_narrative(submission.narrative)
        normalized, language_info, translated = normalize_narrative(submission.narrative)
        submission.narrative = normalized
        request.state.language_code = language_info.code
        request.state.language_translated = translated
    except NarrativeValidationError as exc:
        return _error_response(
            400,
            code=str(exc),
            message="Narrative failed validation checks",
            correlation_id=correlation_id,
        )
    classifier = getattr(app.state, "classifier", None) or get_classifier()
    ner = getattr(app.state, "ner", None) or get_ner()
    acuity_model = getattr(app.state, "acuity_model", None) or get_acuity_model()
    decision_config = getattr(app.state, "decision_config", None) or get_decision_config()

    async def _execute_analysis() -> SafetyDecision:
        start_time = time.perf_counter()
        narrative_raw = submission.narrative or ""
        latency_snapshot: dict[str, Optional[float]] = {"p50": None, "p95": None}
        elapsed_ms: Optional[float] = None
        status_label = "server_error"

        try:
            outcome: AnalysisOutcome = await analyze_submission(
                narrative=narrative_raw,
                classifier=classifier,
                ner=ner,
                acuity_model=acuity_model,
                config=decision_config,
                correlation_id=correlation_id,
            )

            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            latency_snapshot = record_latency(elapsed_ms, endpoint="analyze")
            artifacts = outcome.artifacts or {}
            acuity_payload = artifacts.get("acuity") if isinstance(artifacts.get("acuity"), Mapping) else {}
            probability = None
            if isinstance(acuity_payload, Mapping):
                value = acuity_payload.get("prob_emergency")
                if isinstance(value, (int, float)):
                    probability = float(value)
            record_prediction_metrics(
                probability=probability,
                narrative=narrative_raw,
                red_flags=artifacts.get("red_flag_hits") if isinstance(artifacts.get("red_flag_hits"), list) else None,
                decision=outcome.decision.outcome,
                symptom_mentions=(artifacts.get("nlp") or {}).get("symptom_mentions")
                if isinstance(artifacts.get("nlp"), Mapping)
                else None,
            )
            slo_p95 = float(decision_config.get("latency_slo_p95_ms", _DEFAULT_LATENCY_SLO_MS))
            p95 = latency_snapshot.get("p95")
            if p95 is not None and p95 > slo_p95:
                LOGGER.warning(
                    "safety_gate.latency_slo_exceeded correlation_id=%s p95_ms=%.2f slo_ms=%.2f",
                    correlation_id,
                    p95,
                    slo_p95,
                )

            classification = artifacts.get("classification") if isinstance(artifacts.get("classification"), Mapping) else {}
            nlp_payload = artifacts.get("nlp") if isinstance(artifacts.get("nlp"), Mapping) else {}
            red_flags = artifacts.get("red_flag_hits", [])
            if not isinstance(red_flags, list):
                red_flags = []

            sample_rate = _effective_log_sample_rate(decision_config)
            sample_draw = random.random() if sample_rate > 0 else None
            if _should_sample_request_logs(decision_config, sample=sample_draw):
                _log_request_summary(
                    submission=submission,
                    correlation_id=correlation_id,
                    outcome=outcome,
                    probability=probability,
                    latency_ms=elapsed_ms,
                    latency_snapshot=latency_snapshot,
                    classification=classification,
                    red_flags=red_flags,
                    consent_reference=auth.consent_reference,
                    language_code=getattr(request.state, "language_code", None),
                    translated=getattr(request.state, "language_translated", False),
                )

            if _feature_logging_enabled() and sample_rate > 0:
                feature_draw = sample_draw if sample_draw is not None else random.random()
                if feature_draw <= sample_rate:
                    _log_safety_features(
                        submission=submission,
                        correlation_id=correlation_id,
                        classification=_sanitize_payload(classification),
                        nlp_payload=_sanitize_payload(nlp_payload),
                        decision_result=outcome.decision,
                        lexical_hits=[_redact_pii(str(item)) for item in red_flags],
                        consent_reference=auth.consent_reference,
                    )

            status_label = "success"
            return SafetyDecision(outcome=outcome.decision.outcome, reason=outcome.decision.rationale.get("reason"))
        except HTTPException as exc:
            status_label = "client_error" if 400 <= exc.status_code < 500 else "server_error"
            raise
        except Exception:  # pragma: no cover - defensive path
            LOGGER.exception("safety_gate.analyze.failed correlation_id=%s", correlation_id)
            status_label = "server_error"
            raise
        finally:
            final_elapsed = elapsed_ms if elapsed_ms is not None else (time.perf_counter() - start_time) * 1000.0
            if elapsed_ms is None:
                record_latency(final_elapsed, endpoint="analyze")
            record_request_outcome("analyze", status_label)

    batch_processor = getattr(app.state, "batch_processor", None)
    async def _dispatch() -> SafetyDecision:
        if isinstance(batch_processor, BatchProcessor) and batch_processor.enabled:
            return await batch_processor.submit(_execute_analysis)
        return await _execute_analysis()

    limiter: Optional[ConcurrencyLimiter] = getattr(app.state, "concurrency_limiter", None)
    overload_reason: Optional[str] = None
    if isinstance(limiter, ConcurrencyLimiter):
        overload_reason = await limiter.acquire()
        if overload_reason == "queue":
            record_request_outcome("analyze", "rejected")
            return _error_response(
                429,
                code="too_many_requests",
                message="Safety Gate is handling maximum concurrent requests",
                correlation_id=correlation_id,
                headers={"retry-after": "1"},
            )
        if overload_reason == "timeout":
            record_request_outcome("analyze", "dropped")
            return _error_response(
                503,
                code="service_unavailable",
                message="Timed out waiting for available worker",
                correlation_id=correlation_id,
                headers={"retry-after": "1"},
            )

    try:
        return await _dispatch()
    finally:
        if isinstance(limiter, ConcurrencyLimiter) and overload_reason is None:
            limiter.release()


def _prediction_error(status_code: int, *, code: str, message: str, correlation_id: str) -> HTTPException:
    body = {
        "error": {
            "code": code,
            "message": message,
            "correlationId": correlation_id,
        }
    }
    return HTTPException(status_code=status_code, detail=body)


@app.get("/metrics")
def metrics_endpoint(request: Request) -> Response:
    correlation_id = _extract_correlation_id(request)
    sections = [render_metrics()]
    shadow: Optional[ShadowEvaluator] = getattr(app.state, "shadow_evaluator", None)
    if isinstance(shadow, ShadowEvaluator):
        sections.append(shadow.render_prometheus(service="safety-gate"))
    text_blob = "".join(sections)

    prom_render = render_prometheus_metrics()
    if prom_render is not None:
        prom_payload, media_type = prom_render
        parts = [prom_payload]
        if text_blob:
            if not prom_payload.endswith(b"\n"):
                parts.append(b"\n")
            parts.append(text_blob.encode("utf-8"))
        response = Response(content=b"".join(parts), media_type=media_type)
    else:
        response = Response(content=text_blob, media_type="text/plain; version=0.0.4")
    _attach_correlation_headers(response, correlation_id)
    return response


@app.get("/metrics/golden")
def golden_samples_endpoint(token: Optional[str] = None, reset: bool = False) -> dict[str, object]:
    expected = os.getenv("GOLDEN_SAMPLE_TOKEN")
    if expected and token != expected:
        raise HTTPException(status_code=403, detail={"error": "forbidden"})
    samples = get_golden_samples(reset=reset)
    return {"count": len(samples), "samples": samples}


def set_shadow_evaluator(evaluator: Optional[ShadowEvaluator]) -> None:
    """Allow tests or runtime wiring to register a shadow evaluator."""

    app.state.shadow_evaluator = evaluator


@app.post("/predict", response_model=PredictResponse)
async def predict_endpoint(
    request: Request,
    payload: PredictRequest,
    response: Response,
    auth: AuthzContext = Depends(_PREDICT_AUTH),
) -> PredictResponse:
    start_time = time.perf_counter()
    correlation_id = _extract_correlation_id(request)
    _attach_correlation_headers(response, correlation_id, auth.consent_reference)
    status_label = "server_error"
    limiter: Optional[ConcurrencyLimiter] = getattr(app.state, "concurrency_limiter", None)
    overload_reason: Optional[str] = None
    if isinstance(limiter, ConcurrencyLimiter):
        overload_reason = await limiter.acquire()
        if overload_reason == "queue":
            record_request_outcome("predict", "rejected")
            return _error_response(
                429,
                code="too_many_requests",
                message="Safety Gate is handling maximum concurrent requests",
                correlation_id=correlation_id,
                headers={"retry-after": "1"},
            )
        if overload_reason == "timeout":
            record_request_outcome("predict", "dropped")
            return _error_response(
                503,
                code="service_unavailable",
                message="Timed out waiting for available worker",
                correlation_id=correlation_id,
                headers={"retry-after": "1"},
            )
    try:
        result = predict_outcome(payload)
        status_label = "success"
        return result
    except FileNotFoundError:
        LOGGER.error("safety_gate.predict.missing_artifact correlation_id=%s", correlation_id)
        raise _prediction_error(
            503,
            code="model_unavailable",
            message="Acuity model artifact unavailable",
            correlation_id=correlation_id,
        )
    except Exception:  # pragma: no cover - defensive path
        LOGGER.exception("safety_gate.predict.failed correlation_id=%s", correlation_id)
        raise _prediction_error(
            500,
            code="prediction_failed",
            message="Failed to generate prediction",
            correlation_id=correlation_id,
        )
    finally:
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        observe_request_latency("predict", elapsed_ms)
        record_request_outcome("predict", status_label)
        if isinstance(limiter, ConcurrencyLimiter) and overload_reason is None:
            limiter.release()


@app.post("/predict_proba", response_model=PredictProbaResponse)
async def predict_proba_endpoint(
    request: Request,
    payload: PredictRequest,
    response: Response,
    auth: AuthzContext = Depends(_PREDICT_AUTH),
) -> PredictProbaResponse:
    start_time = time.perf_counter()
    correlation_id = _extract_correlation_id(request)
    _attach_correlation_headers(response, correlation_id, auth.consent_reference)
    status_label = "server_error"
    limiter: Optional[ConcurrencyLimiter] = getattr(app.state, "concurrency_limiter", None)
    overload_reason: Optional[str] = None
    if isinstance(limiter, ConcurrencyLimiter):
        overload_reason = await limiter.acquire()
        if overload_reason == "queue":
            record_request_outcome("predict_proba", "rejected")
            return _error_response(
                429,
                code="too_many_requests",
                message="Safety Gate is handling maximum concurrent requests",
                correlation_id=correlation_id,
                headers={"retry-after": "1"},
            )
        if overload_reason == "timeout":
            record_request_outcome("predict_proba", "dropped")
            return _error_response(
                503,
                code="service_unavailable",
                message="Timed out waiting for available worker",
                correlation_id=correlation_id,
                headers={"retry-after": "1"},
            )
    try:
        result = predict_proba(payload)
        status_label = "success"
        return result
    except FileNotFoundError:
        LOGGER.error("safety_gate.predict_proba.missing_artifact correlation_id=%s", correlation_id)
        raise _prediction_error(
            503,
            code="model_unavailable",
            message="Acuity model artifact unavailable",
            correlation_id=correlation_id,
        )
    except Exception:  # pragma: no cover - defensive path
        LOGGER.exception("safety_gate.predict_proba.failed correlation_id=%s", correlation_id)
        raise _prediction_error(
            500,
            code="prediction_failed",
            message="Failed to generate probability distribution",
            correlation_id=correlation_id,
        )
    finally:
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        observe_request_latency("predict_proba", elapsed_ms)
        record_request_outcome("predict_proba", status_label)
        if isinstance(limiter, ConcurrencyLimiter) and overload_reason is None:
            limiter.release()


def _sanitize_payload(value: Any, key: Optional[str] = None) -> Any:
    if isinstance(value, dict):
        return {k: _sanitize_payload(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_payload(item) for item in value]
    if isinstance(value, str):
        normalized_key = key.lower() if key else ""
        if normalized_key in _SENSITIVE_ID_KEYS:
            return "[REDACTED_ID]"
        if normalized_key in _SENSITIVE_NAME_KEYS:
            return "[REDACTED_NAME]"
        if normalized_key == "correlationid":
            return value
        return _redact_pii(value)
    if isinstance(value, (int, float)) and key:
        normalized_key = key.lower()
        if normalized_key in _SENSITIVE_ID_KEYS:
            return "[REDACTED_ID]"
    return value


def _redact_pii(text: str) -> str:
    if not isinstance(text, str):
        return text
    redacted = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    redacted = _PHONE_RE.sub("[REDACTED_PHONE]", redacted)
    redacted = _DIGIT_RE.sub("[REDACTED_NUMBER]", redacted)
    return redacted


_LOG_SANITIZE_ATTRS = ("details", "payload", "metadata", "context")


def _sanitize_log_args(args: Any) -> Any:
    if isinstance(args, tuple):
        return tuple(_sanitize_payload(value) for value in args)
    if isinstance(args, list):
        return [_sanitize_payload(value) for value in args]
    if isinstance(args, dict):
        sanitized: dict[Any, Any] = {}
        for key, value in args.items():
            key_hint = key if isinstance(key, str) else None
            sanitized[key] = _sanitize_payload(value, key_hint)
        return sanitized
    return _sanitize_payload(args)


class _PiiRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # pragma: no cover - exercised via caplog
        if isinstance(record.msg, str):
            record.msg = _redact_pii(record.msg)
        if record.args:
            record.args = _sanitize_log_args(record.args)
        for attr in _LOG_SANITIZE_ATTRS:
            if hasattr(record, attr):
                setattr(record, attr, _sanitize_payload(getattr(record, attr)))
        return True


def _install_pii_filter() -> None:
    for existing in LOGGER.filters:
        if isinstance(existing, _PiiRedactionFilter):
            return
    LOGGER.addFilter(_PiiRedactionFilter())


_install_pii_filter()
