from __future__ import annotations

import logging
import os
import re
import threading
from collections.abc import Callable
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
        self._model_name = model_name or self.DEFAULT_MODEL
        self._use_stub = self._should_use_stub(env or os.environ)
        self._device_str = device
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

        tokenizer = AutoTokenizer.from_pretrained(self._model_name)
        model = AutoModelForTokenClassification.from_pretrained(self._model_name)
        device = self._resolve_device()
        return pipeline(
            "ner",
            model=model,
            tokenizer=tokenizer,
            aggregation_strategy=self._aggregation_strategy,
            device=device,
        )

    def _resolve_device(self) -> int:
        device = self._device_str.strip().lower()
        if device == "cpu":
            return -1
        if device == "cuda":
            return 0
        raise ValueError(f"Unsupported device '{self._device_str}'. Expected 'cpu' or 'cuda'.")


def _extract_confidence(entity: Mapping[str, Any]) -> float:
    for key in ("score", "confidence", "probability"):
        value = entity.get(key)
        if isinstance(value, (float, int)):
            return float(value)
    return 1.0
