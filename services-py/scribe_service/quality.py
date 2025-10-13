from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Optional, Sequence


@dataclass(frozen=True)
class QualityFlags:
    low_confidence: bool
    silence_detected: bool
    notes: tuple[str, ...]


def evaluate_quality(
    transcript_text: str,
    *,
    chunk_confidences: Optional[Sequence[float]] = None,
    chunk_texts: Optional[Iterable[str]] = None,
    silence_token: str = "[silence]",
    min_density_threshold: float = 0.5,
) -> QualityFlags:
    """
    Produce coarse quality indicators for a transcript.

    Parameters
    ----------
    transcript_text:
        Full transcript string.
    chunk_confidences:
        Optional per-chunk confidence proxy in [0, 1].
    chunk_texts:
        Optional iterable of chunk text segments to help detect silence tokens.
    silence_token:
        Token used to detect explicit silence markers.
    min_density_threshold:
        Minimum word-per-second proxy when confidences are absent.
    """

    normalized_text = (transcript_text or "").strip()
    notes: list[str] = []

    low_confidence = _detect_low_confidence(chunk_confidences, normalized_text, min_density_threshold, notes)
    silence_detected = _detect_silence(normalized_text, chunk_texts or [], silence_token, notes)

    return QualityFlags(
        low_confidence=low_confidence,
        silence_detected=silence_detected,
        notes=tuple(notes),
    )


def _detect_low_confidence(
    confidences: Optional[Sequence[float]],
    text: str,
    threshold: float,
    notes: list[str],
) -> bool:
    if confidences:
        filtered = [value for value in confidences if value is not None]
        if filtered:
            avg_conf = sum(filtered) / len(filtered)
            if avg_conf < 0.6:
                notes.append(f"avg_confidence={avg_conf:.2f}")
                return True
            return False

    # fall back to density heuristic (words per chunk window ~ 30s; use text length)
    word_count = len(text.split())
    if word_count <= 0:
        notes.append("empty_transcript")
        return True
    density = word_count / max(len(text) / 20.0, 1.0)
    if density < threshold:
        notes.append(f"density={density:.2f}")
        return True
    return False


def _detect_silence(text: str, chunks: Iterable[str], token: str, notes: list[str]) -> bool:
    if not text:
        notes.append("no_audio")
        return True
    token_lower = token.lower()
    if token_lower in text.lower():
        notes.append("contains_silence_token")
        return True
    for chunk in chunks:
        if token_lower in chunk.lower():
            notes.append("chunk_silence_token")
            return True
    return False


__all__ = ["QualityFlags", "evaluate_quality"]
