from __future__ import annotations

import logging
import math
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, MutableMapping, Optional, Protocol

LOGGER = logging.getLogger("safety_gate_service.classifier")

_DEFAULT_THRESHOLD = 0.72
_CONFIG_ENV = "SAFETY_GATE_CONFIG_PATH"
_MODEL_VERSION_ENV = "SAFETY_GATE_MODEL_VERSION"
_MODEL_VARIANT_ENV = "SAFETY_GATE_MODEL_VARIANT"
_MODE_ENV = "SAFETY_GATE_CLASSIFIER_MODE"
_THRESHOLD_ENV = "SAFETY_GATE_EMERGENCY_CONFIDENCE"


def _sigmoid(x: float) -> float:
    if x <= -35.0:
        return 0.0
    if x >= 35.0:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def _clamp_probability(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


class CalibrationStrategy(Protocol):
    def __call__(self, *, logit: float, probability: float) -> float:
        """Return a calibrated probability"""


class IdentityCalibration:
    def __call__(self, *, logit: float, probability: float) -> float:
        return _clamp_probability(probability)


class TemperatureCalibration:
    def __init__(self, temperature: float) -> None:
        if temperature <= 0:
            raise ValueError("temperature must be > 0")
        self._temperature = temperature

    def __call__(self, *, logit: float, probability: float) -> float:
        adjusted = _sigmoid(logit / self._temperature)
        return _clamp_probability(adjusted)


class PlattScaling:
    def __init__(self, a: float, b: float) -> None:
        self._a = a
        self._b = b

    def __call__(self, *, logit: float, probability: float) -> float:
        adjusted = 1.0 / (1.0 + math.exp(self._a * logit + self._b))
        return _clamp_probability(adjusted)


@dataclass
class ModelThreshold:
    default: Optional[float] = None
    variants: MutableMapping[str, float] = field(default_factory=dict)
    calibration: Optional[Mapping[str, Any]] = None
    huggingface_model: Optional[str] = None

    def resolve(self, variant: Optional[str], fallback: float) -> float:
        if variant:
            if variant in self.variants:
                return _clamp_probability(self.variants[variant])
        if self.default is not None:
            return _clamp_probability(self.default)
        if "default" in self.variants:
            return _clamp_probability(self.variants["default"])
        for value in self.variants.values():
            return _clamp_probability(value)
        return fallback


class EmergencyClassifier:
    """
    Emergency classifier head with configurable thresholds and calibration hooks.

    Falls back to a deterministic heuristic model when transformer weights are unavailable.
    """

    DEFAULT_MODEL_VERSION = "stub-v1"

    def __init__(
        self,
        *,
        config_path: str | Path | None = None,
        thresholds: Mapping[str, Any] | None = None,
        model_version: Optional[str] = None,
        model_variant: Optional[str] = None,
        calibrator: Optional[CalibrationStrategy] = None,
        env: Optional[Mapping[str, str]] = None,
        model_loader: Optional[Callable[[], Callable[[str], float]]] = None,
    ) -> None:
        self._env = env or os.environ
        self._config_path = self._resolve_config_path(config_path)
        self._model_version = model_version or self._env.get(_MODEL_VERSION_ENV) or self.DEFAULT_MODEL_VERSION
        self._model_variant = model_variant or self._env.get(_MODEL_VARIANT_ENV)
        self._model_loader = model_loader
        (
            self._base_threshold,
            self._model_thresholds,
        ) = self._load_thresholds(thresholds)
        self._preferred_model_name = self._resolve_preferred_model_name()
        self._calibrator = self._resolve_calibrator(calibrator)
        self._override_threshold = self._read_env_threshold_override()
        self._model_lock = threading.Lock()
        self._model: Optional[Callable[[str], float]] = None

    def classify(self, text: str) -> dict[str, Any]:
        if not isinstance(text, str):
            raise TypeError("text must be a string")

        sanitized = text.strip()
        logit = self._score_text(sanitized)
        raw_prob = _sigmoid(logit)
        calibrated_prob = self._calibrator(logit=logit, probability=raw_prob)
        probability = _clamp_probability(calibrated_prob)
        threshold = self._resolve_threshold()
        is_emergency = probability >= threshold

        return {
            "prob_emergency": probability,
            "model_version": self._model_version,
            "threshold": threshold,
            "is_emergency": is_emergency,
        }

    def _resolve_config_path(self, config_path: str | Path | None) -> Path:
        if config_path:
            return Path(config_path)
        env_path = self._env.get(_CONFIG_ENV)
        if env_path:
            return Path(env_path)
        root = Path(__file__).resolve().parents[2]
        return root / "config" / "safety_gate.yaml"

    def _load_thresholds(self, override: Mapping[str, Any] | None) -> tuple[float, dict[str, ModelThreshold]]:
        if override:
            return self._normalise_thresholds(override)

        path = self._config_path
        if not path.exists():
            LOGGER.info("Classifier config not found at %s; using defaults", path)
            return _DEFAULT_THRESHOLD, {}

        try:
            import yaml  # type: ignore
        except ImportError:  # pragma: no cover - guarded in tests
            LOGGER.warning("PyYAML not installed; cannot parse %s. Using defaults.", path)
            return _DEFAULT_THRESHOLD, {}

        try:
            with path.open(encoding="utf-8") as handle:
                parsed = yaml.safe_load(handle) or {}
        except Exception as exc:  # pragma: no cover - unexpected I/O failure
            LOGGER.warning("Failed to read classifier config %s: %s", path, exc)
            return _DEFAULT_THRESHOLD, {}

        if not isinstance(parsed, Mapping):
            LOGGER.warning("Classifier config %s is not a mapping; using defaults", path)
            return _DEFAULT_THRESHOLD, {}

        return self._normalise_thresholds(parsed)

    def _normalise_thresholds(self, data: Mapping[str, Any]) -> tuple[float, dict[str, ModelThreshold]]:
        base = _coerce_threshold(
            data.get("emergency_confidence")
            or data.get("default")
        )

        defaults = data.get("defaults")
        if isinstance(defaults, Mapping):
            candidate = _coerce_threshold(
                defaults.get("emergency_confidence") or defaults.get("default")
            )
            if candidate is not None:
                base = candidate

        if base is None:
            base = _DEFAULT_THRESHOLD

        per_model: dict[str, ModelThreshold] = {}
        models_section = data.get("models")
        if isinstance(models_section, Mapping):
            for name, value in models_section.items():
                model_threshold = self._parse_model_threshold(value)
                if model_threshold:
                    per_model[str(name)] = model_threshold

        return base, per_model

    def _parse_model_threshold(self, raw: Any) -> Optional[ModelThreshold]:
        if isinstance(raw, Mapping):
            default = _coerce_threshold(raw.get("emergency_confidence") or raw.get("default"))
            variants: dict[str, float] = {}
            calibration_node = raw.get("calibration")
            calibration_config = dict(calibration_node) if isinstance(calibration_node, Mapping) else None
            huggingface_model = raw.get("huggingface_model") or raw.get("hf_model")
            huggingface_model_str = str(huggingface_model) if isinstance(huggingface_model, (str, os.PathLike)) else None

            thresholds_node = raw.get("thresholds")
            if isinstance(thresholds_node, Mapping):
                for variant, variant_value in thresholds_node.items():
                    candidate = self._extract_variant_threshold(variant_value)
                    if candidate is not None:
                        variants[str(variant)] = candidate

            # Some configs may collapse A/B variants directly at top-level (e.g. control: 0.7)
            for key, value in raw.items():
                if key in {"emergency_confidence", "default", "thresholds"}:
                    continue
                candidate = self._extract_variant_threshold(value)
                if candidate is not None:
                    variants[str(key)] = candidate

            if default is None and not variants:
                return None

            return ModelThreshold(
                default=default,
                variants=variants,
                calibration=calibration_config,
                huggingface_model=huggingface_model_str,
            )

        candidate = _coerce_threshold(raw)
        if candidate is None:
            return None
        return ModelThreshold(default=candidate)

    def _extract_variant_threshold(self, value: Any) -> Optional[float]:
        if isinstance(value, Mapping):
            candidate = value.get("emergency_confidence") or value.get("value")
            return _coerce_threshold(candidate)
        return _coerce_threshold(value)

    def _read_env_threshold_override(self) -> Optional[float]:
        raw = self._env.get(_THRESHOLD_ENV)
        candidate = _coerce_threshold(raw)
        if candidate is not None:
            return candidate
        return None

    def _resolve_threshold(self) -> float:
        if self._override_threshold is not None:
            return self._override_threshold

        model_threshold = self._model_thresholds.get(self._model_version)
        if model_threshold:
            return model_threshold.resolve(self._model_variant, self._base_threshold)
        return _clamp_probability(self._base_threshold)

    def _get_model(self) -> Callable[[str], float]:
        if self._model is not None:
            return self._model

        with self._model_lock:
            if self._model is not None:
                return self._model

            if self._model_loader:
                self._model = self._model_loader()
            else:
                self._model = self._load_default_model()

        return self._model

    def _load_default_model(self) -> Callable[[str], float]:
        mode_env = (self._env.get(_MODE_ENV) or "").strip()
        if mode_env:
            if mode_env.lower() in {"stub", "heuristic"}:
                return _StubEmergencyModel()
            try:
                return self._load_transformer_model(mode_env)
            except Exception as exc:  # pragma: no cover - exercised when transformers missing
                LOGGER.warning("Falling back to stub classifier: %s", exc, exc_info=False)
                return _StubEmergencyModel()

        if self._preferred_model_name:
            try:
                return self._load_transformer_model(self._preferred_model_name)
            except Exception as exc:  # pragma: no cover - exercised when transformers missing
                LOGGER.warning(
                    "Configured model %s unavailable (%s); falling back to stub",
                    self._preferred_model_name,
                    exc,
                    exc_info=False,
                )
        return _StubEmergencyModel()

    def _load_transformer_model(self, model_name: str) -> Callable[[str], float]:
        try:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline
        except ImportError as err:
            raise RuntimeError("transformers not installed") from err

        tokenizer = AutoTokenizer.from_pretrained(model_name)
        model = AutoModelForSequenceClassification.from_pretrained(model_name)
        clf = pipeline("text-classification", model=model, tokenizer=tokenizer, return_all_scores=True)

        def _predict(text: str) -> float:
            outputs = clf(text)
            if not outputs:
                return float("-inf")
            if isinstance(outputs, list) and outputs and isinstance(outputs[0], list):
                scores = outputs[0]
            else:
                scores = outputs
            emergency_score = 0.0
            fallback_score = 0.0
            for item in scores:
                label = str(item.get("label", "")).lower()
                score = float(item.get("score", 0.0))
                if "emergency" in label or label in {"1", "positive"}:
                    emergency_score = max(emergency_score, score)
                else:
                    fallback_score = max(fallback_score, score)
            emergency_score = min(max(emergency_score, 1e-6), 1.0 - 1e-6)
            odds = emergency_score / (1.0 - emergency_score)
            return math.log(odds)

        return _predict

    def _score_text(self, text: str) -> float:
        model = self._get_model()
        return float(model(text))

    def _resolve_preferred_model_name(self) -> Optional[str]:
        model_threshold = self._model_thresholds.get(self._model_version)
        if model_threshold and model_threshold.huggingface_model:
            return str(model_threshold.huggingface_model)
        return None

    def _resolve_calibrator(self, provided: Optional[CalibrationStrategy]) -> CalibrationStrategy:
        if provided is not None:
            return provided
        model_threshold = self._model_thresholds.get(self._model_version)
        if model_threshold and model_threshold.calibration:
            try:
                return self._build_calibrator(model_threshold.calibration)
            except Exception as exc:
                LOGGER.warning(
                    "Invalid calibration config for model %s: %s; defaulting to identity",
                    self._model_version,
                    exc,
                )
        return IdentityCalibration()

    def _build_calibrator(self, config: Mapping[str, Any]) -> CalibrationStrategy:
        cal_type = str(config.get("type", "identity")).lower()
        if cal_type in {"identity", "none"}:
            return IdentityCalibration()
        if cal_type in {"temperature", "temp"}:
            temperature_value = _coerce_positive_float(
                config.get("temperature")
                or config.get("value")
                or config.get("param")
            )
            if temperature_value is None:
                raise ValueError("temperature calibration requires positive `temperature` value")
            return TemperatureCalibration(temperature=temperature_value)
        if cal_type in {"platt", "platt_scaling"}:
            params = config.get("parameters") if isinstance(config.get("parameters"), Mapping) else config
            a_value = params.get("a")
            b_value = params.get("b")
            if a_value is None or b_value is None:
                raise ValueError("platt calibration requires `a` and `b` coefficients")
            return PlattScaling(float(a_value), float(b_value))
        raise ValueError(f"Unsupported calibration type '{cal_type}'")


def _coerce_threshold(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(numeric):
        return None
    return _clamp_probability(numeric)


def _coerce_positive_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric) or numeric <= 0:
        return None
    return numeric


class _StubEmergencyModel:
    _BIAS = -2.4
    _KEYWORD_WEIGHTS = {
        r"\bchest pain\b": 2.8,
        r"\bcrushing pain\b": 3.1,
        r"\bshortness of breath\b": 2.1,
        r"\bdifficulty breathing\b": 2.0,
        r"\btrouble breathing\b": 1.8,
        r"\bsevere bleeding\b": 2.4,
        r"\bheavy bleeding\b": 2.3,
        r"\bunconscious\b": 2.2,
        r"\bnot responding\b": 2.0,
        r"\bsuicidal\b": 2.5,
        r"\bthinking about dying\b": 2.7,
        r"\b911\b": 2.5,
        r"\bemergency\b": 1.5,
        r"\bstroke\b": 1.8,
        r"\bheart attack\b": 2.6,
    }
    _NEGATIVE_WEIGHTS = {
        r"\bmild\b": -0.5,
        r"\bminor\b": -0.5,
        r"\bresolved\b": -0.4,
        r"\bimproving\b": -0.3,
    }

    def __init__(self) -> None:
        self._positive_patterns = [(re.compile(pattern, re.IGNORECASE), weight) for pattern, weight in self._KEYWORD_WEIGHTS.items()]
        self._negative_patterns = [(re.compile(pattern, re.IGNORECASE), weight) for pattern, weight in self._NEGATIVE_WEIGHTS.items()]

    def __call__(self, text: str) -> float:
        if not text:
            return self._BIAS

        score = self._BIAS
        for pattern, weight in self._positive_patterns:
            if pattern.search(text):
                score += weight

        for pattern, weight in self._negative_patterns:
            if pattern.search(text):
                score += weight

        # Mild length-based boost for longer emergencies (more context).
        length_boost = min(len(text) / 400.0, 1.5)
        score += length_boost * 0.2
        return score
