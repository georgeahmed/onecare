from __future__ import annotations

import logging
import os
import math
import re
import threading
from dataclasses import dataclass
from typing import Any, Mapping, MutableMapping, Optional

import anyio
from anyio import to_thread

from .decision import DEFAULT_RED_FLAG_SET, DecisionResult, decide

LOGGER = logging.getLogger("safety_gate_service.analyzer")


@dataclass(slots=True)
class AnalysisOutcome:
    decision: DecisionResult
    fallback: bool


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
) -> AnalysisOutcome:
    timeout_ms = _extract_timeout(config)
    fallback_mode = str(config.get("fallback", "rules")).strip().lower()
    LOGGER.info("safety_gate.analysis.start correlation_id=%s timeout_ms=%s", correlation_id, timeout_ms)

    try:
        decision = await anyio.fail_after(timeout_ms / 1000.0, _run_pipeline(narrative, classifier, ner, acuity_model, config))
        LOGGER.info(
            "safety_gate.analysis.success correlation_id=%s outcome=%s reason=%s",
            correlation_id,
            decision.outcome,
            decision.rationale.get("reason"),
        )
        return AnalysisOutcome(decision=decision, fallback=False)
    except TimeoutError:
        LOGGER.warning("safety_gate.analysis.timeout correlation_id=%s mode=%s", correlation_id, fallback_mode)
        key = f"timeout_{fallback_mode or 'none'}"
        fallback_metrics.increment(key, correlation_id)
        if fallback_mode == "rules":
            decision = _rules_fallback(narrative, config)
            decision.rationale.setdefault("signals", {})["trigger"] = "timeout"
            return AnalysisOutcome(decision=decision, fallback=True)
        safe_decision = DecisionResult(
            outcome="SAFE_TO_CONTINUE",
            rationale={"reason": "fallback:timeout", "signals": {"trigger": "timeout", "mode": fallback_mode or "none"}},
        )
        return AnalysisOutcome(decision=safe_decision, fallback=True)


async def _run_pipeline(narrative: str, classifier, ner, acuity_model, config: Mapping[str, Any]) -> DecisionResult:
    nlp_analysis = await to_thread.run_sync(ner.analyze, narrative)
    symptom_mentions = _resolve_symptom_mentions(nlp_analysis)
    lexical_hits = _derive_lexical_hits(narrative, config)
    nlp_payload = {
        "symptom_mentions": symptom_mentions,
        "red_flag_hits": lexical_hits,
        "severity": nlp_analysis.get("severity", []),
        "temporal": nlp_analysis.get("temporal", []),
    }
    classification = await to_thread.run_sync(classifier.classify, narrative)
    acuity_estimate = await to_thread.run_sync(
        acuity_model.predict,
        narrative=narrative,
        nlp_results=nlp_payload,
        classifier_result=classification,
    )
    patient_payload = {"acuity": acuity_estimate}
    return decide(
        nlp_results=nlp_payload,
        classifier_result=classification,
        patient=patient_payload,
        config=config,
    )


def _rules_fallback(narrative: str, config: Mapping[str, Any]) -> DecisionResult:
    hits = _derive_lexical_hits(narrative, config)
    if hits:
        rationale = {
            "reason": "fallback:red_flag",
            "signals": {"red_flag": hits[0]},
        }
        return DecisionResult(outcome="DIVERTED", rationale=rationale)
    rationale = {
        "reason": "fallback:safe",
        "signals": {"red_flags": []},
    }
    return DecisionResult(outcome="SAFE_TO_CONTINUE", rationale=rationale)


def _extract_timeout(config: Mapping[str, Any]) -> float:
    raw = config.get("timeout_ms")
    if isinstance(raw, (int, float)) and math.isfinite(raw) and raw > 0:
        return float(raw)
    env_override = os.getenv("SAFETY_GATE_TIMEOUT_MS")
    if env_override:
        try:
            value = float(env_override)
            if math.isfinite(value) and value > 0:
                return value
        except ValueError:
            pass
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
        normalized = item.lower()
        pattern = re.compile(rf"\b{re.escape(normalized)}\b", re.IGNORECASE)
        if pattern.search(narrative):
            hits.append(normalized.replace(" ", "_"))
    return hits
