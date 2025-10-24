from __future__ import annotations

import logging
import os
import math
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Mapping, MutableMapping, Optional

import anyio
from anyio import to_thread

from common.otel import span

from .decision import DEFAULT_RED_FLAG_SET, DecisionResult, decide
from .language import NarrativeLanguage

LOGGER = logging.getLogger("safety_gate_service.analyzer")


@dataclass
class AnalysisOutcome:
    decision: DecisionResult
    fallback: bool
    artifacts: dict[str, Any] = field(default_factory=dict)


class FallbackMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: MutableMapping[str, int] = {}

    def increment(self, key: str, correlation_id: Optional[str] = None) -> None:
        with self._lock:
            self._counts[key] = self._counts.get(key, 0) + 1
        LOGGER.warning("safety_gate.fallback reason=%s correlation_id=%s", key, correlation_id)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return dict(self._counts)

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()


fallback_metrics = FallbackMetrics()


async def analyze_submission(
    *,
    narrative: str,
    classifier,
    ner,
    acuity_model,
    config: Mapping[str, Any],
    correlation_id: Optional[str] = None,
    language: Optional[NarrativeLanguage] = None,
    translated: bool = False,
) -> AnalysisOutcome:
    timeout_ms = _extract_timeout(config)
    fallback_mode = str(config.get("fallback", "rules")).strip().lower()
    LOGGER.info("safety_gate.analysis.start correlation_id=%s timeout_ms=%s", correlation_id, timeout_ms)

    if language is not None and not language.is_english and not translated:
        LOGGER.warning(
            "safety_gate.analysis.language_fallback correlation_id=%s language=%s translated=%s mode=%s",
            correlation_id,
            language.code,
            translated,
            fallback_mode or "none",
        )
        return _language_fallback(
            narrative=narrative,
            config=config,
            fallback_mode=fallback_mode,
            language=language,
            correlation_id=correlation_id,
            translated=translated,
        )

    try:
        with anyio.fail_after(timeout_ms / 1000.0):
            decision, artifacts = await _run_pipeline(
                narrative,
                classifier,
                ner,
                acuity_model,
                config,
                correlation_id=correlation_id,
            )
        LOGGER.info(
            "safety_gate.analysis.success correlation_id=%s outcome=%s reason=%s",
            correlation_id,
            decision.outcome,
            decision.rationale.get("reason"),
        )
        return AnalysisOutcome(decision=decision, fallback=False, artifacts=artifacts)
    except TimeoutError:
        LOGGER.warning("safety_gate.analysis.timeout correlation_id=%s mode=%s", correlation_id, fallback_mode)
        key = f"timeout_{fallback_mode or 'none'}"
        fallback_metrics.increment(key, correlation_id)
        artifacts = {"trigger": "timeout", "mode": fallback_mode or "none", "red_flag_hits": []}
        if fallback_mode == "rules":
            decision, fallback_artifacts = _rules_fallback(narrative, config)
            decision.rationale.setdefault("signals", {})["trigger"] = "timeout"
            artifacts.update(fallback_artifacts)
            return AnalysisOutcome(decision=decision, fallback=True, artifacts=artifacts)
        safe_decision = DecisionResult(
            outcome="SAFE_TO_CONTINUE",
            rationale={"reason": "fallback:timeout", "signals": {"trigger": "timeout", "mode": fallback_mode or "none"}},
        )
        return AnalysisOutcome(decision=safe_decision, fallback=True, artifacts=artifacts)
    except Exception as exc:
        LOGGER.exception(
            "safety_gate.analysis.error correlation_id=%s mode=%s error=%s",
            correlation_id,
            fallback_mode or "none",
            exc.__class__.__name__,
        )
        key = f"error_{fallback_mode or 'none'}"
        fallback_metrics.increment(key, correlation_id)
        artifacts = {
            "trigger": "error",
            "mode": fallback_mode or "none",
            "red_flag_hits": [],
            "errorType": exc.__class__.__name__,
        }
        if fallback_mode == "rules":
            decision, fallback_artifacts = _rules_fallback(narrative, config)
            signals = decision.rationale.setdefault("signals", {})
            signals["trigger"] = "error"
            signals["errorType"] = exc.__class__.__name__
            artifacts.update(fallback_artifacts)
            return AnalysisOutcome(decision=decision, fallback=True, artifacts=artifacts)
        safe_decision = DecisionResult(
            outcome="SAFE_TO_CONTINUE",
            rationale={
                "reason": "fallback:error",
                "signals": {
                    "trigger": "error",
                    "mode": fallback_mode or "none",
                    "errorType": exc.__class__.__name__,
                },
            },
        )
        return AnalysisOutcome(decision=safe_decision, fallback=True, artifacts=artifacts)


async def _run_pipeline(
    narrative: str,
    classifier,
    ner,
    acuity_model,
    config: Mapping[str, Any],
    correlation_id: Optional[str] = None,
) -> tuple[DecisionResult, dict[str, Any]]:
    span_attrs = {"correlation_id": correlation_id}

    with span("safety_gate.ner.analyze", span_attrs):
        nlp_analysis = await to_thread.run_sync(ner.analyze, narrative)
    symptom_mentions = _resolve_symptom_mentions(nlp_analysis)
    lexical_hits = _derive_lexical_hits(narrative, config)
    nlp_payload = {
        "symptom_mentions": symptom_mentions,
        "red_flag_hits": lexical_hits,
        "severity": nlp_analysis.get("severity", []),
        "temporal": nlp_analysis.get("temporal", []),
    }
    classifier_attrs = dict(span_attrs)
    model_version = getattr(classifier, "_model_version", None)
    if model_version:
        classifier_attrs["model_version"] = model_version
    with span("safety_gate.classifier.classify", classifier_attrs):
        classification = await to_thread.run_sync(classifier.classify, narrative)
    with span("safety_gate.acuity.predict", span_attrs):
        acuity_estimate = await to_thread.run_sync(
            lambda: acuity_model.predict(
                narrative=narrative,
                nlp_results=nlp_payload,
                classifier_result=classification,
            )
        )
    patient_payload = {"acuity": acuity_estimate}
    with span("safety_gate.decision.evaluate", span_attrs):
        decision = decide(
            nlp_results=nlp_payload,
            classifier_result=classification,
            patient=patient_payload,
            config=config,
        )
    artifacts = {
        "nlp": nlp_payload,
        "classification": classification,
        "acuity": acuity_estimate,
        "red_flag_hits": lexical_hits,
    }
    return decision, artifacts


def _language_fallback(
    *,
    narrative: str,
    config: Mapping[str, Any],
    fallback_mode: str,
    language: NarrativeLanguage,
    correlation_id: Optional[str],
    translated: bool,
) -> AnalysisOutcome:
    key = f"language_{fallback_mode or 'none'}"
    fallback_metrics.increment(key, correlation_id)
    artifacts: dict[str, Any] = {
        "trigger": "non_english",
        "mode": fallback_mode or "none",
        "language": language.code,
        "translated": translated,
        "red_flag_hits": [],
    }
    if fallback_mode == "rules":
        decision, fallback_artifacts = _rules_fallback(narrative, config)
        signals = decision.rationale.setdefault("signals", {})
        signals["trigger"] = "non_english"
        signals["language"] = language.code
        artifacts.update(fallback_artifacts)
        return AnalysisOutcome(decision=decision, fallback=True, artifacts=artifacts)
    safe_decision = DecisionResult(
        outcome="SAFE_TO_CONTINUE",
        rationale={
            "reason": "fallback:language",
            "signals": {
                "trigger": "non_english",
                "language": language.code,
                "mode": fallback_mode or "none",
            },
        },
    )
    return AnalysisOutcome(decision=safe_decision, fallback=True, artifacts=artifacts)


def _rules_fallback(narrative: str, config: Mapping[str, Any]) -> tuple[DecisionResult, dict[str, Any]]:
    hits = _derive_lexical_hits(narrative, config)
    if hits:
        rationale = {
            "reason": "fallback:red_flag",
            "signals": {"red_flag": hits[0]},
        }
        return DecisionResult(outcome="DIVERTED", rationale=rationale), {"red_flag_hits": hits}
    rationale = {
        "reason": "fallback:safe",
        "signals": {"red_flags": []},
    }
    return DecisionResult(outcome="SAFE_TO_CONTINUE", rationale=rationale), {"red_flag_hits": []}


def _extract_timeout(config: Mapping[str, Any]) -> float:
    env_override = os.getenv("SAFETY_GATE_TIMEOUT_MS")
    if env_override:
        try:
            value = float(env_override)
            if math.isfinite(value) and value > 0:
                return value
        except ValueError:
            pass

    raw = config.get("timeout_ms")
    if isinstance(raw, (int, float)) and math.isfinite(raw) and raw > 0:
        return float(raw)
    return 800.0


def _resolve_symptom_mentions(nlp_analysis: Mapping[str, Any]) -> list[dict[str, Any]]:
    mentions: list[dict[str, Any]] = []
    raw_mentions = nlp_analysis.get("symptom_mentions")
    if isinstance(raw_mentions, list):
        for item in raw_mentions:
            if isinstance(item, Mapping):
                name = item.get("name") or item.get("text")
                if isinstance(name, str):
                    confidence = item.get("confidence")
                    mentions.append(
                        {
                            "name": name,
                            "confidence": float(confidence) if isinstance(confidence, (int, float)) else None,
                            "source": item.get("source") or "ner",
                        }
                    )
    if not mentions:
        for name in nlp_analysis.get("symptoms", []):
            if isinstance(name, str):
                mentions.append({"name": name, "confidence": None, "source": "ner"})
    return mentions


def _derive_lexical_hits(narrative: str, config: Mapping[str, Any]) -> list[str]:
    red_flag_set = config.get("red_flag_set")
    if isinstance(red_flag_set, list) and red_flag_set:
        working = [str(item) for item in red_flag_set if isinstance(item, str)]
    else:
        working = list(DEFAULT_RED_FLAG_SET)

    hits: list[str] = []
    for item in working:
        normalized_item = item.strip().lower()
        if not normalized_item:
            continue
        normalized = normalized_item
        pattern = re.compile(rf"\b{re.escape(normalized)}\b", re.IGNORECASE)
        if pattern.search(narrative):
            hits.append(normalized.replace(" ", "_"))
    return hits
