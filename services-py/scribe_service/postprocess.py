from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable

from .token_utils import truncate_to_tokens

UNCERTAINTY_TERMS = {"maybe", "possibly", "unclear", "unsure", "consider", "appears", "likely"}
ENV_FLAG = "UNCERTAINTY_HIGHLIGHT"
FALLBACK_ENV_FLAG = "SCRIBE_UNCERTAINTY_HIGHLIGHT"


def should_highlight_uncertainty() -> bool:
    env_value = os.getenv(ENV_FLAG)
    if env_value is not None:
        return env_value.strip().lower() in {"1", "true", "yes", "on"}
    fallback = os.getenv(FALLBACK_ENV_FLAG)
    if fallback is not None:
        return fallback.strip().lower() in {"1", "true", "yes", "on"}
    return True


def highlight_uncertainty(summary: str, *, max_tokens: int | None = None) -> str:
    if not should_highlight_uncertainty():
        return summary
    if not summary:
        return summary

    words = summary.split()
    highlighted = []
    for word in words:
        cleaned = word.strip(".,;:!?").lower()
        if cleaned in UNCERTAINTY_TERMS:
            highlighted.append(f"[UNCERTAIN]{word}[/UNCERTAIN]")
        else:
            highlighted.append(word)
    highlighted_summary = " ".join(highlighted)
    if max_tokens is not None and max_tokens > 0:
        return truncate_to_tokens(highlighted_summary, max_tokens)
    return highlighted_summary


__all__ = ["highlight_uncertainty", "should_highlight_uncertainty"]
