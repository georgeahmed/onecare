from __future__ import annotations

import re
from typing import Optional


_MAX_CHARS = 500000
_MIN_ALPHA_RATIO = 0.2
_MAX_REPEAT_BLOCK = 6


class NarrativeValidationError(ValueError):
    """Raised when input text fails sanity checks."""


def validate_narrative(text: Optional[str]) -> str:
    if text is None:
        raise NarrativeValidationError("narrative_missing")
    candidate = text.strip()
    if not candidate:
        raise NarrativeValidationError("narrative_empty")
    if len(candidate) > _MAX_CHARS:
        raise NarrativeValidationError("narrative_too_long")

    alpha_count = sum(ch.isalpha() for ch in candidate)
    ratio = alpha_count / len(candidate)
    if ratio < _MIN_ALPHA_RATIO:
        raise NarrativeValidationError("narrative_low_signal")

    repeats = re.compile(r"(.)\1{%d,}" % (_MAX_REPEAT_BLOCK - 1))
    if repeats.search(candidate):
        raise NarrativeValidationError("narrative_repeated_chars")

    if any(
        ord(ch) < 32 and ch not in {"\n", "\r", "\t"}
        for ch in candidate
    ):
        raise NarrativeValidationError("narrative_invalid_chars")

    if any(not ch.isprintable() and ch not in {"\n", "\r", "\t"} for ch in candidate):
        raise NarrativeValidationError("narrative_invalid_chars")

    return candidate
