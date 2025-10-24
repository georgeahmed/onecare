from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from .asr_chunking import ChunkTranscript, ChunkWindow, concat_transcripts, generate_windows
from .diarize import DiarizationResult, DiarizationSegment, diarize

DEFAULT_MODEL_NAME = "base"
DEFAULT_REPO_ID = "openai/whisper-base"
DEFAULT_CACHE_SUBDIR = "whisper"


@dataclass(frozen=True)
class WhisperModel:
    """Lightweight reference to a Whisper model cached on disk."""

    name: str
    repo_id: str
    path: Path


@dataclass(frozen=True)
class TranscriptionChunk:
    index: int
    start: float
    end: float
    text: str
    speaker: Optional[str] = None


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    chunks: tuple[TranscriptionChunk, ...]
    model_name: str


def load_model(
    name: str = DEFAULT_MODEL_NAME,
    *,
    cache_dir: str | Path | None = None,
    repo_id: Optional[str] = None,
) -> WhisperModel:
    """
    Prepare a Whisper model reference for downstream transcription.

    This stub simply creates a cache directory structure and drops metadata so that future
    implementations can download real weights without changing the interface.
    """

    resolved_name = name.strip() or DEFAULT_MODEL_NAME
    resolved_repo = repo_id or _default_repo_for(resolved_name)
    base_cache = Path(cache_dir) if cache_dir is not None else _default_cache_dir()
    model_path = base_cache / DEFAULT_CACHE_SUBDIR / resolved_name
    model_path.mkdir(parents=True, exist_ok=True)

    metadata_path = model_path / "model.json"
    if not metadata_path.exists():
        metadata_payload = {
            "name": resolved_name,
            "repo": resolved_repo,
            "created": datetime.now(timezone.utc).isoformat(),
        }
        metadata_path.write_text(json.dumps(metadata_payload, indent=2), encoding="utf-8")

    return WhisperModel(name=resolved_name, repo_id=resolved_repo, path=model_path)


def transcribe(
    audio_ref: Any,
    *,
    model: WhisperModel | None = None,
    chunk_seconds: float = 30.0,
    enable_diarization: bool = True,
) -> TranscriptionResult:
    """
    Generate a deterministic transcription stub for the given audio reference.

    When duration metadata is available the audio is split into fixed-size windows; otherwise a
    single chunk captures the whole reference. The returned text encodes chunk boundaries for
    integration testing without depending on the Whisper runtime.
    """

    if chunk_seconds <= 0:
        raise ValueError("chunk_seconds must be positive")

    normalized_ref = _normalize_audio_ref(audio_ref)
    duration = normalized_ref.get("duration")
    identifier = normalized_ref.get("id") or "audio"

    windows = _determine_windows(duration, chunk_seconds)
    diarization: DiarizationResult | None = None
    if enable_diarization:
        diarization = diarize(normalized_ref)

    chunk_transcripts: list[ChunkTranscript] = []
    result_chunks: list[TranscriptionChunk] = []
    for window in windows:
        speaker: Optional[str] = None
        if diarization is not None:
            speaker = _resolve_speaker_for_range(window.start, window.end, diarization.segments)
        prefix = f"[{speaker}] " if speaker else ""
        chunk_text = f"{prefix}{identifier} chunk={window.index + 1}"
        chunk_transcripts.append(ChunkTranscript(window=window, text=chunk_text))
        result_chunks.append(
            TranscriptionChunk(
                index=window.index,
                start=window.start,
                end=window.end,
                text=chunk_text,
                speaker=speaker,
            )
        )

    model_name = model.name if model else DEFAULT_MODEL_NAME
    transcript_text = concat_transcripts(chunk_transcripts)
    return TranscriptionResult(text=transcript_text, chunks=tuple(result_chunks), model_name=model_name)


def _default_cache_dir() -> Path:
    return Path.home() / ".cache" / "onecare" / "asr"


def _default_repo_for(model_name: str) -> str:
    normalized = model_name.lower()
    if normalized in {"tiny", "base", "small", "medium", "large"}:
        return f"openai/whisper-{normalized}"
    return DEFAULT_REPO_ID


def _normalize_audio_ref(audio_ref: Any) -> dict[str, Any]:
    if isinstance(audio_ref, Mapping):
        url = str(audio_ref.get("url") or audio_ref.get("audioUrl") or audio_ref.get("id") or "audio")
        duration = _coerce_duration(
            audio_ref.get("durationSeconds")
            or audio_ref.get("duration")
            or audio_ref.get("lengthSeconds")
        )
        return {"id": url, "duration": duration}

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


def _determine_windows(duration: Optional[float], chunk_seconds: float) -> tuple[ChunkWindow, ...]:
    if duration is None:
        return (ChunkWindow(index=0, start=0.0, end=chunk_seconds),)
    return generate_windows(duration, chunk_seconds=chunk_seconds, overlap_seconds=1.0)


def _resolve_speaker_for_range(
    start: float,
    end: float,
    segments: Sequence[DiarizationSegment],
) -> str:
    best_speaker = None
    best_overlap = 0.0
    for segment in segments:
        overlap = max(0.0, min(end, segment.end) - max(start, segment.start))
        if overlap > best_overlap + 1e-6:
            best_overlap = overlap
            best_speaker = segment.speaker
    if best_speaker:
        return best_speaker
    if segments:
        return segments[0].speaker
    return "SPEAKER_1"


__all__ = [
    "WhisperModel",
    "TranscriptionResult",
    "TranscriptionChunk",
    "load_model",
    "transcribe",
]
