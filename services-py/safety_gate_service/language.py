from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from langdetect import DetectorFactory, LangDetectException, detect

DetectorFactory.seed = 0

_ENGLISH_CODES = {"en", "en-gb", "en-us"}


@dataclass
class NarrativeLanguage:
    code: str
    confidence: float = 1.0

    @property
    def is_english(self) -> bool:
        return self.code.lower() in _ENGLISH_CODES


def detect_language(text: str) -> NarrativeLanguage:
    try:
        code = detect(text)
    except LangDetectException:
        return NarrativeLanguage(code="unknown", confidence=0.0)
    normalized = code.lower()
    if normalized in _ENGLISH_CODES:
        return NarrativeLanguage(code="en", confidence=0.99)
    return NarrativeLanguage(code=normalized, confidence=0.85)


def normalize_narrative(text: str) -> tuple[str, NarrativeLanguage, bool]:
    """Return normalized text, detected language, and translation flag."""

    language = detect_language(text)
    translated = False
    normalized_text = text
    if not language.is_english:
        # Placeholder translation hook: integrations will supply actual MT.
        normalized_text = text  # For now we keep source narrative.
        translated = False
    return normalized_text, language, translated
