from __future__ import annotations

import logging
import os
import re
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, Dict, List, Mapping, MutableMapping

LOGGER = logging.getLogger("safety_gate_service.ner")

SafetyNERResult = Dict[str, Any]

_LABEL_MAP: Mapping[str, str] = {
    "SYMPTOM": "symptoms",
    "SYMPTOMS": "symptoms",
    "PROBLEM": "symptoms",
    "CONDITION": "symptoms",
    "SEVERITY": "severity",
    "TEMPORAL": "temporal",
    "DATE": "temporal",
    "DURATION": "temporal",
    "FREQUENCY": "temporal",
    "CONTEXT": "context_entities",
    "TREATMENT": "context_entities",
    "MEDICATION": "context_entities",
}

_DEVICE_ENV = "SAFETY_GATE_DEVICE"
_QUANTIZATION_ENV = "SAFETY_GATE_ENABLE_QUANTIZATION"
_MODEL_MAX_BYTES_ENV = "SAFETY_GATE_MAX_MODEL_BYTES"
_REMOTE_MODELS_ENV = "SAFETY_GATE_ALLOW_REMOTE_MODELS"


def _env_flag(env: Mapping[str, str], name: str) -> bool:
    value = env.get(name)
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_int(value: str | None, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_value(raw: str) -> str:
    return " ".join(raw.strip().split())


def _build_stub_pipeline() -> Callable[[str], list[dict[str, Any]]]:
    keyword_map = {
        "chest pain": "SYMPTOM",
        "shortness of breath": "SYMPTOM",
        "breathing": "SYMPTOM",
        "difficulty breathing": "SYMPTOM",
        "suicidal": "SYMPTOM",
        "severe": "SEVERITY",
        "mild": "SEVERITY",
        "today": "TEMPORAL",
        "yesterday": "TEMPORAL",
        "last night": "TEMPORAL",
        "three days": "TEMPORAL",
        "emergency": "CONTEXT",
        "er": "CONTEXT",
    }

    compiled = [(re.compile(rf"\b{re.escape(phrase)}\b"), phrase, label) for phrase, label in keyword_map.items()]

    def _pipeline(text: str) -> list[dict[str, Any]]:
        lowered = text.lower()
        results: list[dict[str, Any]] = []
        for pattern, phrase, label in compiled:
            if pattern.search(lowered):
                results.append({"entity_group": label, "word": phrase, "score": 0.9, "model": "stub"})
        return results

    return _pipeline


class SafetyNER:
    """
    Thin wrapper around a HuggingFace NER pipeline with lazy, thread-safe initialization.

    Falls back to a deterministic stub when the full model is unavailable (e.g., in CI).
    """

    DEFAULT_MODEL = "emilyalsentzer/Bio_ClinicalBERT"

    def __init__(
        self,
        *,
        model_name: str | None = None,
        device: str = "cpu",
        aggregation_strategy: str = "simple",
        env: Mapping[str, str] | None = None,
    ) -> None:
        env_map = env or os.environ
        self._env = env_map
        self._model_name = model_name or env_map.get("SAFETY_GATE_NER_MODEL") or self.DEFAULT_MODEL
        self._use_stub = self._should_use_stub(env_map)
        requested_device = (env_map.get(_DEVICE_ENV) or device).strip().lower() or "cpu"
        if requested_device not in {"cpu", "cuda"}:
            LOGGER.debug("NER received unsupported device '%s'; defaulting to cpu", requested_device)
            requested_device = "cpu"
        self._device_str = requested_device
        self._enable_quantization = _env_flag(env_map, _QUANTIZATION_ENV)
        self._max_model_bytes = max(0, _parse_int(env_map.get(_MODEL_MAX_BYTES_ENV)))
        self._allow_remote_models = _env_flag(env_map, _REMOTE_MODELS_ENV)
        self._aggregation_strategy = aggregation_strategy
        self._pipeline_lock = threading.Lock()
        self._pipeline: Callable[[str], list[dict[str, Any]]] | None = None

    @staticmethod
    def _should_use_stub(env: Mapping[str, str]) -> bool:
        return env.get("SAFETY_GATE_NER_MODE", "").lower() == "stub"

    def analyze(self, text: str) -> SafetyNERResult:
        if not isinstance(text, str):
            raise TypeError("text must be a string")

        pipeline = self._get_pipeline()
        entities = pipeline(text)

        bucket: Dict[str, List[str]] = {key: [] for key in ("symptoms", "severity", "temporal", "context_entities")}
        symptom_mentions: MutableMapping[str, dict[str, Any]] = {}

        for entity in entities or []:
            label = (
                entity.get("entity_group")
                or entity.get("entity")
                or entity.get("label")
                or entity.get("type")
            )
            if not isinstance(label, str):
                continue
            target = _LABEL_MAP.get(label.upper())
            if not target:
                continue
            raw_value = entity.get("word") or entity.get("text")
            if not isinstance(raw_value, str):
                continue
            normalized = _normalize_value(raw_value)
            if not normalized:
                continue
            if normalized not in bucket[target]:
                bucket[target].append(normalized)

            if target == "symptoms":
                confidence = _extract_confidence(entity)
                key = normalized.lower()
                mention = symptom_mentions.get(key)
                if mention is None or confidence > mention["confidence"]:
                    symptom_mentions[key] = {
                        "name": normalized,
                        "confidence": confidence,
                        "source": entity.get("model") or ("hf" if not self._use_stub else "stub"),
                    }

        return {
            "symptoms": bucket["symptoms"],
            "severity": bucket["severity"],
            "temporal": bucket["temporal"],
            "context_entities": bucket["context_entities"],
            "symptom_mentions": list(symptom_mentions.values()),
        }

    def _get_pipeline(self) -> Callable[[str], list[dict[str, Any]]]:
        if self._pipeline is not None:
            return self._pipeline

        with self._pipeline_lock:
            if self._pipeline is not None:
                return self._pipeline

            if self._use_stub:
                LOGGER.info("SafetyNER using stub pipeline due to SAFETY_GATE_NER_MODE=stub")
                self._pipeline = _build_stub_pipeline()
                return self._pipeline

            try:
                self._pipeline = self._load_pipeline()
            except Exception as exc:  # pragma: no cover - fallback is deterministic
                LOGGER.warning("Falling back to stub NER pipeline: %s", exc, exc_info=False)
                self._pipeline = _build_stub_pipeline()

        return self._pipeline

    def _load_pipeline(self) -> Callable[[str], list[dict[str, Any]]]:
        try:
            from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline
        except ImportError as err:
            raise RuntimeError("transformers not installed") from err

        if not self._allow_remote_models:
            candidate = Path(self._model_name)
            if not candidate.exists():
                raise RuntimeError("remote model downloads disabled; provide local NER model bundle")

        tokenizer = AutoTokenizer.from_pretrained(self._model_name)
        model = AutoModelForTokenClassification.from_pretrained(self._model_name)
        self._enforce_memory_budget(model)
        model = self._maybe_quantize_model(model)
        device_index = self._resolve_device()
        return pipeline(
            "ner",
            model=model,
            tokenizer=tokenizer,
            aggregation_strategy=self._aggregation_strategy,
            device=device_index,
        )

    def _resolve_device(self) -> int:
        device = self._device_str.strip().lower()
        if device == "cpu":
            return -1
        if device == "cuda":
            try:
                import torch

                if torch.cuda.is_available():
                    return 0
                LOGGER.warning("CUDA requested for NER but not available; using cpu")
                self._device_str = "cpu"
                return -1
            except ImportError:
                LOGGER.warning("CUDA requested for NER but torch unavailable; using cpu")
                self._device_str = "cpu"
                return -1
        LOGGER.warning("Unsupported device '%s'; defaulting to cpu", self._device_str)
        self._device_str = "cpu"
        return -1

    def _enforce_memory_budget(self, model: Any) -> None:
        if self._max_model_bytes <= 0:
            return
        try:
            import torch
        except ImportError:
            LOGGER.debug("Skipping NER memory budget check; torch unavailable")
            return
        try:
            total = 0
            for param in model.parameters():
                total += param.nelement() * param.element_size()
            for buffer in model.buffers():
                total += buffer.nelement() * buffer.element_size()
        except Exception as exc:  # pragma: no cover - defensive guard
            LOGGER.debug("Unable to estimate NER model size: %s", exc)
            return
        if total > self._max_model_bytes:
            raise RuntimeError(
                f"NER model exceeds memory budget ({total} bytes > {self._max_model_bytes})"
            )

    def _maybe_quantize_model(self, model: Any) -> Any:
        if not self._enable_quantization or self._device_str != "cpu":
            return model
        try:
            import torch
        except ImportError:
            LOGGER.debug("Quantization skipped for NER; torch unavailable")
            return model
        try:
            quantized = torch.quantization.quantize_dynamic(  # type: ignore[attr-defined]
                model,
                {torch.nn.Linear},
                dtype=torch.qint8,
            )
        except Exception as exc:  # pragma: no cover - quantization optional
            LOGGER.debug("NER quantization failed: %s", exc)
            return model
        LOGGER.info("Applied dynamic quantization to NER model")
        return quantized


def _extract_confidence(entity: Mapping[str, Any]) -> float:
    for key in ("score", "confidence", "probability"):
        value = entity.get(key)
        if isinstance(value, (float, int)):
            return float(value)
    return 1.0
