from __future__ import annotations

import logging
import math
import os
import threading
from typing import Any, Mapping, Optional
from urllib.parse import urlparse

LOGGER = logging.getLogger("safety_gate_service.acuity")

_MODE_ENV = "SAFETY_GATE_ACUITY_MODE"
_MODEL_PATH_ENV = "SAFETY_GATE_ACUITY_MODEL_PATH"
_MODEL_MAX_BYTES_ENV = "SAFETY_GATE_MAX_MODEL_BYTES"


def _parse_int(value: Optional[str], default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class AcuityModel:
    """
    Produce an emergency acuity estimate using either a trained model bundle or a deterministic stub.

    The stub keeps runtime deterministic while allowing calibration/threshold tests to run in CI.
    """

    DEFAULT_VERSION = "stub-v1"

    def __init__(
        self,
        *,
        env: Optional[Mapping[str, str]] = None,
        model_path: Optional[str] = None,
    ) -> None:
        self._env = env or os.environ
        self._model_path = model_path or self._env.get(_MODEL_PATH_ENV)
        self._mode = (self._env.get(_MODE_ENV) or "stub").lower().strip()
        self._model_lock = threading.Lock()
        self._model = None
        self._model_version = self.DEFAULT_VERSION
        self._max_model_bytes = max(0, _parse_int(self._env.get(_MODEL_MAX_BYTES_ENV)))

    def predict(
        self,
        *,
        narrative: str,
        nlp_results: Mapping[str, Any],
        classifier_result: Mapping[str, Any],
    ) -> dict[str, Any]:
        predictor = self._get_model()
        probability = predictor(narrative=narrative, nlp_results=nlp_results, classifier_result=classifier_result)
        probability = _clamp_probability(probability)
        level = _derive_level(probability)
        return {
            "model_version": self._model_version,
            "prob_emergency": probability,
            "level": level,
        }

    def _get_model(self):
        if self._model is not None:
            return self._model

        with self._model_lock:
            if self._model is not None:
                return self._model

            if self._mode not in {"", "stub", "heuristic"} and self._model_path:
                try:
                    self._model = self._load_bundle(self._model_path)
                    self._model_version = os.path.basename(self._model_path.rstrip("/")) or "bundle"
                    LOGGER.info("Loaded acuity model bundle from %s", self._model_path)
                    return self._model
                except Exception as exc:  # pragma: no cover - exercised when bundle missing
                    LOGGER.warning("Failed to load acuity bundle (%s); falling back to stub", exc, exc_info=False)

            self._model = _heuristic_predictor
            self._model_version = self.DEFAULT_VERSION

        return self._model

    def _load_bundle(self, path: str):
        parsed = urlparse(path)
        if parsed.scheme and parsed.scheme not in {"", "file"}:
            raise RuntimeError("remote acuity bundles are not permitted")
        if parsed.scheme == "file":
            path = parsed.path
        try:
            import joblib  # type: ignore
        except ImportError as err:  # pragma: no cover - optional dependency
            raise RuntimeError("joblib not installed for acuity bundle loading") from err

        if self._max_model_bytes > 0:
            try:
                file_size = os.path.getsize(path)
            except OSError as exc:
                LOGGER.warning("Unable to read acuity model size for %s: %s", path, exc)
            else:
                if file_size > self._max_model_bytes:
                    raise RuntimeError(
                        f"acuity model bundle exceeds memory budget ({file_size} bytes > {self._max_model_bytes})"
                    )

        loaded = joblib.load(path)
        if not callable(loaded):
            raise RuntimeError("Loaded acuity bundle is not callable")
        return loaded


def _clamp_probability(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def _derive_level(probability: float) -> str:
    if probability >= 0.8:
        return "emergency"
    if probability >= 0.6:
        return "urgent"
    return "routine"


def _heuristic_predictor(
    *,
    narrative: str,
    nlp_results: Mapping[str, Any],
    classifier_result: Mapping[str, Any],
) -> float:
    probability = 0.05

    classifier_prob = classifier_result.get("prob_emergency")
    if isinstance(classifier_prob, (float, int)):
        probability = max(probability, float(classifier_prob) * 0.9)

    symptom_mentions = nlp_results.get("symptom_mentions") or []
    for mention in symptom_mentions:
        if not isinstance(mention, Mapping):
            continue
        name = str(mention.get("name") or "")
        confidence = mention.get("confidence")
        if isinstance(confidence, (float, int)):
            probability = max(probability, float(confidence) * 0.85)
        if "chest pain" in name.lower() or "severe bleeding" in name.lower():
            probability = max(probability, 0.9)

    red_flag_hits = nlp_results.get("red_flag_hits") or []
    if any("suicidal" in str(hit).lower() for hit in red_flag_hits):
        probability = max(probability, 0.88)

    words = len(narrative.split())
    if words > 120:
        probability = min(1.0, probability + 0.05)

    return probability
