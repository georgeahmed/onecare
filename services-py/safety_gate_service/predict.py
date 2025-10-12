from __future__ import annotations

import json
import math
import os
import pickle
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union

from pydantic import BaseModel, ConfigDict, Field

from common.calibration import TemperatureCalibrator
from common.features.encode_features import EMBEDDING_SIZE, encode_features

_MODEL_PATH_ENV = "SAFETY_GATE_ACUITY_MODEL_PATH"
_META_PATH_ENV = "SAFETY_GATE_ACUITY_META_PATH"
_DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[1] / "models"
_LABEL_NAMES = {0: "routine", 1: "urgent", 2: "emergency"}


class SymptomMention(BaseModel):
    name: str
    confidence: Optional[float] = None

    def to_raw(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"name": self.name}
        if self.confidence is not None:
            payload["confidence"] = self.confidence
        return payload


class PatientContext(BaseModel):
    ageYears: Optional[float] = None
    comorbidities: Optional[Union[Dict[str, Any], List[str]]] = None

    def to_raw(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if self.ageYears is not None:
            payload["age"] = self.ageYears
        if self.comorbidities is not None:
            payload["comorbidities"] = self.comorbidities
        return payload


class PredictRequest(BaseModel):
    symptomMentions: List[SymptomMention] = Field(default_factory=list)
    symptoms: List[str] = Field(default_factory=list)
    patient: PatientContext = Field(default_factory=PatientContext)

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "symptomMentions": [
                    {"name": "Severe chest pain", "confidence": 0.9},
                    {"name": "Shortness of breath"},
                ],
                "patient": {"ageYears": 67, "comorbidities": {"cardiac": True, "diabetes": True}},
            }
        }
    )

    def to_feature_payload(self) -> dict[str, Any]:
        raw: dict[str, Any] = {"patient": self.patient.to_raw() if self.patient else {}}
        if self.symptomMentions:
            raw["symptom_mentions"] = [mention.to_raw() for mention in self.symptomMentions]
        elif self.symptoms:
            raw["symptom_mentions"] = list(self.symptoms)
        else:
            raw["symptom_mentions"] = []
        return raw


class PredictResponse(BaseModel):
    level: str
    probEmergency: float
    modelVersion: str


class PredictProbaResponse(BaseModel):
    probabilities: Dict[str, float]
    modelVersion: str


@dataclass(frozen=True)
class _ModelBundle:
    prototypes: Dict[int, List[float]]
    metadata: Mapping[str, Any]
    calibrator: TemperatureCalibrator


def _resolve_model_paths(
    model_path: Optional[str] = None, meta_path: Optional[str] = None
) -> tuple[Path, Path]:
    model_candidate = Path(model_path or os.getenv(_MODEL_PATH_ENV) or _DEFAULT_MODELS_DIR / "acuity_model.pkl")
    meta_candidate = Path(meta_path or os.getenv(_META_PATH_ENV) or _DEFAULT_MODELS_DIR / "acuity.meta.json")
    return model_candidate, meta_candidate


@lru_cache(maxsize=1)
def load_model_bundle(model_path: Optional[str] = None, meta_path: Optional[str] = None) -> _ModelBundle:
    model_file, meta_file = _resolve_model_paths(model_path, meta_path)

    if not model_file.exists():
        raise FileNotFoundError(f"Acuity model artifact not found at {model_file}")

    with model_file.open("rb") as handle:
        artifact = pickle.load(handle)

    prototypes_raw = artifact.get("prototypes")
    if not isinstance(prototypes_raw, Mapping):
        raise RuntimeError("Acuity model artifact is missing prototypes mapping")

    prototypes: dict[int, list[float]] = {}
    for label, vector in prototypes_raw.items():
        if isinstance(vector, Iterable):
            prototypes[int(label)] = [float(value) for value in vector]

    metadata: Mapping[str, Any] = {}
    if meta_file.exists():
        metadata = json.loads(meta_file.read_text(encoding="utf-8"))

    calibration = metadata.get("calibration", {})
    temperature = float(calibration.get("temperature", 1.0))
    threshold = float(calibration.get("threshold", 0.5))
    threshold = min(max(threshold, 0.0), 1.0)
    temperature = max(temperature, 1e-6)
    calibrator = TemperatureCalibrator(temperature=temperature, threshold=threshold)

    return _ModelBundle(prototypes=prototypes, metadata=metadata, calibrator=calibrator)


def predict_outcome(
    payload: PredictRequest, *, model_path: Optional[str] = None, meta_path: Optional[str] = None
) -> PredictResponse:
    bundle = load_model_bundle(model_path, meta_path)
    features = payload.to_feature_payload()
    encoded = encode_features(features)
    vector = _flatten_features(encoded)
    distances = {label: _euclidean_distance(vector, proto) for label, proto in bundle.prototypes.items()}
    score = _emergency_score(distances, bundle.prototypes)
    emergency_prob = bundle.calibrator.probability(score)
    probabilities = _resolve_probabilities(distances, bundle.calibrator, emergency_prob)
    level = max(probabilities.items(), key=lambda item: item[1])[0]
    model_version = _resolve_model_version(bundle)
    return PredictResponse(level=level, probEmergency=emergency_prob, modelVersion=model_version)


def predict_proba(
    payload: PredictRequest, *, model_path: Optional[str] = None, meta_path: Optional[str] = None
) -> PredictProbaResponse:
    bundle = load_model_bundle(model_path, meta_path)
    encoded = encode_features(payload.to_feature_payload())
    vector = _flatten_features(encoded)
    distances = {label: _euclidean_distance(vector, proto) for label, proto in bundle.prototypes.items()}
    score = _emergency_score(distances, bundle.prototypes)
    emergency_prob = bundle.calibrator.probability(score)
    probabilities = _resolve_probabilities(distances, bundle.calibrator, emergency_prob)
    model_version = _resolve_model_version(bundle)
    return PredictProbaResponse(probabilities=probabilities, modelVersion=model_version)


def _flatten_features(encoded: Mapping[str, Any]) -> list[float]:
    embedding_values = list(encoded.get("symptom_embedding") or [])
    if len(embedding_values) < EMBEDDING_SIZE:
        embedding_values = embedding_values + [0.0] * (EMBEDDING_SIZE - len(embedding_values))
    elif len(embedding_values) > EMBEDDING_SIZE:
        embedding_values = embedding_values[:EMBEDDING_SIZE]

    age = float(encoded.get("age_years") or 0.0)
    flags = encoded.get("comorbidity_flags") or {}
    diabetes = 1.0 if flags.get("diabetes") else 0.0
    cardiac = 1.0 if flags.get("cardiac") else 0.0
    respiratory = 1.0 if flags.get("respiratory") else 0.0
    return embedding_values + [age, diabetes, cardiac, respiratory]


def _euclidean_distance(a: Sequence[float], b: Sequence[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _emergency_score(distances: Mapping[int, float], prototypes: Mapping[int, Sequence[float]]) -> float:
    emergency_dist = distances.get(2)
    if emergency_dist is None:
        return 0.0
    other = [dist for label, dist in distances.items() if label != 2]
    other_dist = min(other) if other else emergency_dist + 1.0
    return other_dist - emergency_dist


def _resolve_probabilities(
    distances: Mapping[int, float], calibrator: TemperatureCalibrator, emergency_prob: float
) -> Dict[str, float]:
    weights = {label: math.exp(-dist) for label, dist in distances.items()}
    normalizer = sum(weights.values()) or 1.0
    base = {label: weight / normalizer for label, weight in weights.items()}
    prob_emergency = min(max(emergency_prob, 0.0), 1.0)
    other_labels = [label for label in base if label != 2]
    other_mass = 1.0 - prob_emergency
    base_other_total = sum(base[label] for label in other_labels) or 1.0
    probabilities: dict[str, float] = {}

    for label in base:
        if label == 2:
            probabilities[_LABEL_NAMES.get(label, str(label))] = prob_emergency
        else:
            share = base[label] / base_other_total
            probabilities[_LABEL_NAMES.get(label, str(label))] = max(other_mass, 0.0) * share

    if "emergency" not in probabilities:
        probabilities["emergency"] = prob_emergency

    # Ensure all known labels are present for downstream consumers.
    for label, name in _LABEL_NAMES.items():
        probabilities.setdefault(name, 0.0)

    return probabilities


def _resolve_model_version(bundle: _ModelBundle) -> str:
    if isinstance(bundle.metadata.get("modelVersion"), str):
        return str(bundle.metadata["modelVersion"])
    if isinstance(bundle.metadata.get("schema"), str):
        return str(bundle.metadata["schema"])
    return "acuity-model"
