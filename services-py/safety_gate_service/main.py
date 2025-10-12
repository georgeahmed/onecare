from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Mapping, Optional
from uuid import uuid4
from urllib import error as urllib_error, request as urllib_request

from fastapi import FastAPI, HTTPException, Request
from common.contracts.models import PortalSubmission, SafetyDecision
from common.otel import instrument_fastapi
from .acuity import AcuityModel
from .analyzer import AnalysisOutcome, analyze_submission
from .classifier import EmergencyClassifier
from .decision import DEFAULT_RED_FLAG_SET
from .ner import SafetyNER


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


def _feature_logging_enabled() -> bool:
    value = os.getenv("FEATURE_LOGGING", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _feature_log_endpoint() -> Optional[str]:
    candidate = os.getenv(_FEATURE_LOG_ENDPOINT_ENV, "http://orchestrator:3001/feature-log")
    trimmed = candidate.strip()
    return trimmed or None


def _emit_feature_log(payload: dict[str, Any]) -> None:
    if not _feature_logging_enabled():
        return

    endpoint = _feature_log_endpoint()
    if not endpoint:
        return

    try:
        data = json.dumps(payload, default=str).encode("utf-8")
    except (TypeError, ValueError) as exc:  # pragma: no cover - serialization guard
        LOGGER.debug("Failed to serialize feature payload: %s", exc)
        return

    request_obj = urllib_request.Request(
        endpoint,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib_request.urlopen(request_obj, timeout=_FEATURE_LOG_TIMEOUT)
    except urllib_error.URLError as exc:
        LOGGER.debug("Feature logging request failed: %s", getattr(exc, "reason", exc))
    except Exception as exc:  # pragma: no cover - defensive logging
        LOGGER.debug("Feature logging request errored: %s", exc)


def _log_safety_features(
    *,
    submission: PortalSubmission,
    correlation_id: Optional[str],
    classification: Mapping[str, Any],
    nlp_payload: Mapping[str, Any],
    decision_result,
    lexical_hits: list[str],
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

    analysis_id = str(uuid4())
    payload = {
        "source": "safety",
        "entityId": submission.patient.id,
        "patientId": submission.patient.id,
        "correlationId": correlation_id,
        "features": feature_packet,
        "metadata": {
            "practiceId": submission.practiceId,
            "channel": submission.channel,
            "analysisId": analysis_id,
            "recordedAt": datetime.now(timezone.utc).isoformat(),
        },
    }

    _emit_feature_log(payload)


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
    try:
        app.state.classifier = get_classifier()
        app.state.ner = get_ner()
        app.state.acuity_model = get_acuity_model()
        app.state.decision_config = get_decision_config()
    except Exception as exc:  # pragma: no cover - startup failure path
        LOGGER.exception("Failed to initialize EmergencyClassifier: %s", exc)
        raise
    app.state.model_ready = True
    try:
        yield
    finally:
        app.state.model_ready = False
        app.state.classifier = None
        app.state.ner = None
        app.state.acuity_model = None
        app.state.decision_config = None


app = FastAPI(title="Safety Gate Service", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.exception_handler(RequestValidationError)
async def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    correlation_id = _extract_correlation_id(request)
    body = {
        "error": {
            "code": "invalid_input",
            "message": "Invalid request payload",
            "details": {"errors": exc.errors()},
            "correlationId": correlation_id,
        }
    }
    LOGGER.info("safety_gate.validation_error correlation_id=%s", correlation_id)
    response = JSONResponse(status_code=400, content=body)
    response.headers["x-correlation-id"] = correlation_id
    return response


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    if getattr(app.state, "model_ready", False):
        return {"status": "ready"}
    raise HTTPException(status_code=503, detail={"status": "not_ready"})


@app.post("/analyze", response_model=SafetyDecision)
async def analyze(request: Request, submission: PortalSubmission, response: Response) -> SafetyDecision:
    narrative_raw = submission.narrative or ""
    classifier = getattr(app.state, "classifier", None) or get_classifier()
    ner = getattr(app.state, "ner", None) or get_ner()
    acuity_model = getattr(app.state, "acuity_model", None) or get_acuity_model()
    decision_config = getattr(app.state, "decision_config", None) or get_decision_config()

    correlation_id = _extract_correlation_id(request)
    response.headers["x-correlation-id"] = correlation_id

    outcome: AnalysisOutcome = await analyze_submission(
        narrative=narrative_raw,
        classifier=classifier,
        ner=ner,
        acuity_model=acuity_model,
        config=decision_config,
        correlation_id=correlation_id,
    )

    if _feature_logging_enabled():
        artifacts = outcome.artifacts or {}
        classification = artifacts.get("classification") if isinstance(artifacts.get("classification"), Mapping) else {}
        nlp_payload = artifacts.get("nlp") if isinstance(artifacts.get("nlp"), Mapping) else {}
        red_flags = artifacts.get("red_flag_hits", [])
        if not isinstance(red_flags, list):
            red_flags = []
        _log_safety_features(
            submission=submission,
            correlation_id=correlation_id,
            classification=classification,
            nlp_payload=nlp_payload,
            decision_result=outcome.decision,
            lexical_hits=red_flags,
        )

    return SafetyDecision(outcome=outcome.decision.outcome, reason=outcome.decision.rationale.get("reason"))
