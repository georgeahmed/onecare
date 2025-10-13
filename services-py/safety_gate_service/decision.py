from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional


DEFAULT_RED_FLAG_SET = {
    "chest pain",
    "shortness of breath",
    "difficulty breathing",
    "unresponsive",
    "severe bleeding",
    "suicidal ideation",
}

DEFAULT_THRESHOLDS = {
    "red_flag_threshold": 0.65,
    "emergency_confidence": 0.70,
    "acuity_threshold_emergency": 0.75,
}


def _normalize_phrase(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _sanitize_reason_prefix(prefix: str, detail: str) -> str:
    normalized_detail = detail.replace(" ", "_")
    return f"{prefix}:{normalized_detail}"


def _coerce_probability(value: Any) -> Optional[float]:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(numeric):
        return None
    if numeric < 0.0:
        return 0.0
    if numeric > 1.0:
        return 1.0
    return numeric


def _extract_threshold(config: Mapping[str, Any], key: str) -> float:
    if key in config:
        candidate = _coerce_probability(config[key])
        if candidate is not None:
            return candidate
    return DEFAULT_THRESHOLDS[key]


@dataclass
class DecisionResult:
    outcome: str  # "DIVERTED" | "SAFE_TO_CONTINUE"
    rationale: dict[str, Any]


def decide(
    nlp_results: Mapping[str, Any],
    classifier_result: Mapping[str, Any],
    patient: Mapping[str, Any] | None,
    config: Mapping[str, Any] | None,
) -> DecisionResult:
    """
    Combine NER, classifier, and optional acuity signals into a deterministic decision.

    Parameters
    ----------
    nlp_results:
        Output from SafetyNER and downstream augmentation. Expected keys:
        - symptom_mentions: Iterable[{"name"/"text": str, "confidence": float?}]
        - red_flag_hits: Iterable[str] (optional precomputed hits)

    classifier_result:
        Result from EmergencyClassifier.classify() containing `prob_emergency`,
        optional `threshold`, `is_emergency`, and `model_version`.

    patient:
        Mapping containing optional `acuity` dict with `level` or `probability`.

    config:
        Safety gate configuration with red flag lexicon and thresholds.
    """

    config = config or {}
    patient = patient or {}

    red_flag_threshold = _extract_threshold(config, "red_flag_threshold")
    classifier_threshold = _resolve_classifier_threshold(classifier_result, config)
    acuity_threshold = _extract_threshold(config, "acuity_threshold_emergency")
    red_flag_set = _resolve_red_flag_set(config)

    red_flag_hits = _collect_red_flag_hits(nlp_results, red_flag_set, red_flag_threshold)
    if red_flag_hits:
        reason = _sanitize_reason_prefix("red_flag", red_flag_hits[0])
        rationale = {
            "reason": reason,
            "signals": {
                "red_flags": red_flag_hits,
                "threshold": red_flag_threshold,
            },
        }
        return DecisionResult(outcome="DIVERTED", rationale=rationale)

    classifier_prob = _coerce_probability(classifier_result.get("prob_emergency"))
    classifier_model = classifier_result.get("model_version")
    if classifier_prob is not None and classifier_prob >= classifier_threshold:
        rationale = {
            "reason": _sanitize_reason_prefix("classifier", "probability"),
            "signals": {
                "probability": classifier_prob,
                "threshold": classifier_threshold,
                "model_version": classifier_model,
            },
        }
        return DecisionResult(outcome="DIVERTED", rationale=rationale)

    acuity_info = patient.get("acuity", {}) if isinstance(patient.get("acuity"), Mapping) else {}
    acuity_level = (acuity_info.get("level") or "").strip().lower()
    if acuity_level == "emergency":
        rationale = {
            "reason": _sanitize_reason_prefix("acuity", "level"),
            "signals": {
                "level": acuity_level,
            },
        }
        return DecisionResult(outcome="DIVERTED", rationale=rationale)

    acuity_prob = _coerce_probability(
        acuity_info.get("probability") or acuity_info.get("prob_emergency") or acuity_info.get("score")
    )
    if acuity_prob is not None and acuity_prob >= acuity_threshold:
        rationale = {
            "reason": _sanitize_reason_prefix("acuity", "probability"),
            "signals": {
                "probability": acuity_prob,
                "threshold": acuity_threshold,
            },
        }
        return DecisionResult(outcome="DIVERTED", rationale=rationale)

    rationale = {
        "reason": "safe",
        "signals": {
            "probability": classifier_prob,
            "threshold": classifier_threshold,
            "red_flags": [],
        },
    }
    return DecisionResult(outcome="SAFE_TO_CONTINUE", rationale=rationale)


def _resolve_classifier_threshold(classifier_result: Mapping[str, Any], config: Mapping[str, Any]) -> float:
    candidate = _coerce_probability(classifier_result.get("threshold"))
    if candidate is not None:
        return candidate
    return _extract_threshold(config, "emergency_confidence")


def _resolve_red_flag_set(config: Mapping[str, Any]) -> set[str]:
    raw_values = None
    if "red_flag_set" in config and isinstance(config["red_flag_set"], Iterable):
        raw_values = config["red_flag_set"]
    elif "red_flags" in config and isinstance(config["red_flags"], Iterable):
        raw_values = config["red_flags"]

    if raw_values is None:
        return {_normalize_phrase(item) for item in DEFAULT_RED_FLAG_SET}

    values = {_normalize_phrase(str(item)) for item in raw_values if isinstance(item, str)}
    if not values:
        return {_normalize_phrase(item) for item in DEFAULT_RED_FLAG_SET}
    return values


def _collect_red_flag_hits(
    nlp_results: Mapping[str, Any],
    red_flag_set: set[str],
    threshold: float,
) -> list[str]:
    hits: list[str] = []

    mentions = []
    if isinstance(nlp_results.get("symptom_mentions"), Iterable):
        mentions = list(nlp_results.get("symptom_mentions"))  # type: ignore[arg-type]

    for mention in mentions:
        if not isinstance(mention, Mapping):
            continue
        name = mention.get("name") or mention.get("text")
        if not isinstance(name, str):
            continue
        normalized = _normalize_phrase(name)
        if not normalized or normalized not in red_flag_set:
            continue
        confidence = mention.get("confidence")
        if confidence is None:
            confidence = mention.get("score") or mention.get("probability")
        confidence_value = _coerce_probability(confidence)
        if confidence_value is None:
            confidence_value = 1.0
        if confidence_value >= threshold:
            hits.append(normalized.replace(" ", "_"))

    precomputed_hits = []
    if isinstance(nlp_results.get("red_flag_hits"), Iterable):
        precomputed_hits = [str(item) for item in nlp_results.get("red_flag_hits")]  # type: ignore[list-item]

    for item in precomputed_hits:
        normalized = _normalize_phrase(item)
        if normalized in red_flag_set and normalized.replace(" ", "_") not in hits:
            hits.append(normalized.replace(" ", "_"))

    return hits
