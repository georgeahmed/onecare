from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List

EMBEDDING_SIZE = 8
MAX_AGE = 120


def encode_features(raw: Dict[str, Any]) -> Dict[str, Any]:
    features = raw or {}
    embedding = _encode_embedding(features.get("symptom_mentions") or features.get("symptoms") or [])
    age_years = _encode_age(features.get("patient", {}).get("age"))
    flags = _encode_comorbidities(features.get("patient", {}).get("comorbidities"))

    return {
        "symptom_embedding": embedding,
        "age_years": age_years,
        "comorbidity_flags": flags,
    }


def _encode_embedding(symptoms: Iterable[Any]) -> List[float]:
    values = []
    if isinstance(symptoms, dict):
        values = list(symptoms.values())
    else:
        values = list(symptoms)

    accum = [0.0] * EMBEDDING_SIZE
    count = 0

    for item in values:
        text = ""
        if isinstance(item, str):
            text = item
        elif isinstance(item, dict):
            text = str(item.get("name") or item.get("text") or "")
        if not text:
            continue
        count += 1
        for index, char in enumerate(text.lower()):
            if char.isalpha():
                accum[index % EMBEDDING_SIZE] += (ord(char) - 96)
            else:
                accum[index % EMBEDDING_SIZE] += 0.5

    if count == 0:
        return [0.0] * EMBEDDING_SIZE

    norm = math.sqrt(sum(value * value for value in accum)) or 1.0
    return [round(value / norm, 6) for value in accum]


def _encode_age(value: Any) -> float:
    try:
        age = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(MAX_AGE, age))


def _encode_comorbidities(data: Any) -> Dict[str, bool]:
    flags = {"diabetes": False, "cardiac": False, "respiratory": False}
    if isinstance(data, dict):
        for key in flags:
            flags[key] = bool(data.get(key))
        return flags
    if isinstance(data, (list, tuple, set)):
        normalized = {str(item).lower() for item in data}
        flags["diabetes"] = "diabetes" in normalized
        flags["cardiac"] = any(alias in normalized for alias in {"cardiac", "heart", "cardiovascular"})
        flags["respiratory"] = any(alias in normalized for alias in {"respiratory", "asthma", "copd"})
    return flags
