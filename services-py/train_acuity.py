#!/usr/bin/env python3

from __future__ import annotations

import json
import math
import pickle
from pathlib import Path

from common.features.encode_features import encode_features
from common.calibration import fit_temperature_threshold

MODEL_DIR = Path(__file__).resolve().parent / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
TRAINING_DATA_PATH = MODEL_DIR / "acuity_training_data.pkl"
MODEL_PATH = MODEL_DIR / "acuity_model.pkl"
META_PATH = MODEL_DIR / "acuity.meta.json"


def _load_training_samples() -> list[dict]:
    if TRAINING_DATA_PATH.exists():
        with TRAINING_DATA_PATH.open("rb") as handle:
            return pickle.load(handle)

    synthetic = [
        {
            "symptom_mentions": ["Severe chest pain", "Shortness of breath"],
            "patient": {"age": 67, "comorbidities": {"cardiac": True, "diabetes": True}},
            "label": 2,
        },
        {
            "symptom_mentions": ["Mild headache"],
            "patient": {"age": 29, "comorbidities": {}},
            "label": 0,
        },
        {
            "symptom_mentions": ["High fever", "Persistent cough"],
            "patient": {"age": 42, "comorbidities": {"respiratory": True}},
            "label": 1,
        },
        {
            "symptom_mentions": ["Shortness of breath", "Dizziness"],
            "patient": {"age": 75, "comorbidities": {"cardiac": True}},
            "label": 2,
        },
    ]

    with TRAINING_DATA_PATH.open("wb") as handle:
        pickle.dump(synthetic, handle)

    return synthetic


def _flatten_features(encoded: dict[str, object]) -> list[float]:
    embedding = list(encoded["symptom_embedding"])
    age = encoded["age_years"]
    flags = encoded["comorbidity_flags"]
    return list(embedding) + [float(age), float(flags["diabetes"]), float(flags["cardiac"]), float(flags["respiratory"])]


def _euclidean_distance(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _emergency_score(vector: list[float], prototypes: dict[int, list[float]]) -> float:
    emergency = prototypes.get(2)
    if emergency is None:
        return 0.0

    emergency_dist = _euclidean_distance(vector, emergency)
    other = [dist for label, proto in prototypes.items() if label != 2 for dist in [_euclidean_distance(vector, proto)]]
    other_dist = min(other) if other else emergency_dist + 1.0
    return other_dist - emergency_dist


def main() -> None:
    samples = _load_training_samples()

    vectors = []
    labels = []
    for record in samples:
        encoded = encode_features(record)
        vectors.append(list(_flatten_features(encoded)))
        labels.append(int(record["label"]))

    prototypes = {}
    for vector, label in zip(vectors, labels):
        bucket = prototypes.setdefault(label, {"sum": [0.0] * len(vector), "count": 0})
        bucket["sum"] = [s + v for s, v in zip(bucket["sum"], vector)]
        bucket["count"] += 1

    for label, entry in prototypes.items():
        if entry["count"]:
            prototypes[label] = [value / entry["count"] for value in entry["sum"]]
        else:
            prototypes[label] = entry["sum"]

    with MODEL_PATH.open("wb") as handle:
        pickle.dump({"prototypes": prototypes, "schema": "https://onecare/features/acuity/v1"}, handle)

    scores = [_emergency_score(vector, prototypes) for vector in vectors]
    calibrator = fit_temperature_threshold(scores, labels, positive_label=2)

    metadata = {
        "schema": "https://onecare/features/acuity/v1",
        "classes": list(prototypes.keys()),
        "training_samples": len(samples),
        "calibration": {
            "temperature": calibrator.temperature,
            "threshold": calibrator.threshold,
            "positive_label": 2,
        },
    }
    META_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Training completed. Model saved to {MODEL_PATH}")


if __name__ == "__main__":
    main()
