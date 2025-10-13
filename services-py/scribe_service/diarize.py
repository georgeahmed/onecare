from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

DEFAULT_SEGMENT_SECONDS = 15.0
DEFAULT_MAX_SPEAKERS = 2


@dataclass(frozen=True)
class DiarizationSegment:
    index: int
    start: float
    end: float
    speaker: str


@dataclass(frozen=True)
class DiarizationResult:
    segments: tuple[DiarizationSegment, ...]
    speaker_count: int


def diarize(
    audio_ref: Any,
    *,
    segment_seconds: float = DEFAULT_SEGMENT_SECONDS,
    max_speakers: int = DEFAULT_MAX_SPEAKERS,
) -> DiarizationResult:
    """
    Produce deterministic diarization segments by allocating alternating speaker ranges.

    This stub keeps the interface stable while downstream integrations are developed. It does not
    perform real audio processing, but mirrors the structure expected from a diarization model.
    """

    if segment_seconds <= 0:
        raise ValueError("segment_seconds must be positive")
    if max_speakers <= 0:
        raise ValueError("max_speakers must be positive")

    normalized = _normalize_audio_ref(audio_ref)
    duration = normalized.get("duration")

    if duration is None:
        segment = DiarizationSegment(index=0, start=0.0, end=segment_seconds, speaker="SPEAKER_1")
        return DiarizationResult(segments=(segment,), speaker_count=1)

    total_segments = max(1, math.ceil(duration / segment_seconds))
    segments: list[DiarizationSegment] = []
    for index in range(total_segments):
        start = index * segment_seconds
        end = min(duration, (index + 1) * segment_seconds)
        speaker_id = (index % max_speakers) + 1
        segment = DiarizationSegment(
            index=index,
            start=start,
            end=end,
            speaker=f"SPEAKER_{speaker_id}",
        )
        segments.append(segment)

    unique_speakers = {segment.speaker for segment in segments}
    return DiarizationResult(segments=tuple(segments), speaker_count=len(unique_speakers))


def _normalize_audio_ref(audio_ref: Any) -> dict[str, Any]:
    if isinstance(audio_ref, Mapping):
        return {
            "id": str(audio_ref.get("url") or audio_ref.get("audioUrl") or audio_ref.get("id") or "audio"),
            "duration": _coerce_duration(
                audio_ref.get("durationSeconds")
                or audio_ref.get("duration")
                or audio_ref.get("lengthSeconds")
            ),
        }
    return {"id": str(audio_ref), "duration": None}


def _coerce_duration(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        candidate = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(candidate) or candidate <= 0:
        return None
    return candidate


__all__ = ["DiarizationSegment", "DiarizationResult", "diarize"]

