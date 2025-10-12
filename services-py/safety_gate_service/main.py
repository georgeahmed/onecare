from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from common.contracts.models import PortalSubmission, SafetyDecision
from common.otel import instrument_fastapi
from .classifier import EmergencyClassifier
from .decision import DecisionResult, DEFAULT_RED_FLAG_SET, decide
from .ner import SafetyNER


LOGGER = logging.getLogger("safety_gate_service.main")
_CLASSIFIER: Optional[EmergencyClassifier] = None
_NER: Optional[SafetyNER] = None
_CLASSIFIER_LOCK = Lock()
_NER_LOCK = Lock()
_DECISION_CONFIG: Optional[dict[str, Any]] = None
_DECISION_CONFIG_LOCK = Lock()


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
        for key in ("red_flag_threshold", "emergency_confidence", "acuity_threshold_emergency"):
            if key in safety_gate_cfg:
                base_config[key] = safety_gate_cfg[key]

    return base_config


def reset_models_for_testing() -> None:
    """Reset cached models so tests can reconfigure env thresholds."""

    global _CLASSIFIER
    global _NER
    global _DECISION_CONFIG
    with _CLASSIFIER_LOCK:
        _CLASSIFIER = None
    with _NER_LOCK:
        _NER = None
    with _DECISION_CONFIG_LOCK:
        _DECISION_CONFIG = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.model_ready = False
    try:
        app.state.classifier = get_classifier()
        app.state.ner = get_ner()
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
        app.state.decision_config = None


app = FastAPI(title="Safety Gate Service", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    if getattr(app.state, "model_ready", False):
        return {"status": "ready"}
    raise HTTPException(status_code=503, detail={"status": "not_ready"})


@app.post("/analyze", response_model=SafetyDecision)
def analyze(submission: PortalSubmission) -> SafetyDecision:
    narrative_raw = submission.narrative or ""
    classifier = getattr(app.state, "classifier", None) or get_classifier()
    ner = getattr(app.state, "ner", None) or get_ner()
    decision_config = getattr(app.state, "decision_config", None) or get_decision_config()

    nlp_analysis = ner.analyze(narrative_raw)
    symptom_mentions = [{"name": name, "confidence": 1.0, "source": "ner"} for name in nlp_analysis.get("symptoms", [])]
    lexical_hits = _derive_lexical_hits(narrative_raw, decision_config)
    nlp_payload = {
        "symptom_mentions": symptom_mentions,
        "red_flag_hits": lexical_hits,
        "severity": nlp_analysis.get("severity", []),
        "temporal": nlp_analysis.get("temporal", []),
    }

    try:
        classification = classifier.classify(narrative_raw)
    except Exception as exc:  # pragma: no cover - runtime fallback
        LOGGER.exception("Emergency classifier failed, defaulting to SAFE_TO_CONTINUE: %s", exc)
        return SafetyDecision(outcome="SAFE_TO_CONTINUE")

    decision_result: DecisionResult = decide(
        nlp_results=nlp_payload,
        classifier_result=classification,
        patient={},
        config=decision_config,
    )

    return SafetyDecision(outcome=decision_result.outcome, reason=decision_result.rationale.get("reason"))


def _derive_lexical_hits(narrative: str, config: dict[str, Any]) -> list[str]:
    narrative_lower = narrative.lower()
    hits: list[str] = []
    for item in config.get("red_flag_set", DEFAULT_RED_FLAG_SET):
        if not isinstance(item, str):
            continue
        normalized = item.lower()
        if not normalized:
            continue
        pattern = re.compile(rf"\b{re.escape(normalized)}\b", re.IGNORECASE)
        if pattern.search(narrative):
            hits.append(normalized)
    return hits
