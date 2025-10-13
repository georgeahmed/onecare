from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple


@dataclass(frozen=True)
class ChunkWindow:
    index: int
    start: float
    end: float


@dataclass(frozen=True)
class ChunkTranscript:
    window: ChunkWindow
    text: str


def generate_windows(
    duration: float,
    *,
    chunk_seconds: float,
    overlap_seconds: float = 1.0,
) -> Tuple[ChunkWindow, ...]:
    if duration <= 0:
        raise ValueError("duration must be positive")
    if chunk_seconds <= 0:
        raise ValueError("chunk_seconds must be positive")
    if overlap_seconds < 0:
        raise ValueError("overlap_seconds cannot be negative")
    if overlap_seconds >= chunk_seconds:
        raise ValueError("overlap_seconds must be smaller than chunk_seconds")

    windows: List[ChunkWindow] = []
    start = 0.0
    index = 0
    while start < duration:
        end = min(duration, start + chunk_seconds)
        windows.append(ChunkWindow(index=index, start=start, end=end))
        index += 1
        start = start + chunk_seconds - overlap_seconds

    if not windows:
        windows.append(ChunkWindow(index=0, start=0.0, end=duration))

    return tuple(windows)


def concat_transcripts(chunks: Sequence[ChunkTranscript]) -> str:
    segments = []
    for chunk in sorted(chunks, key=lambda item: (item.window.start, item.window.index)):
        stamp = f"[{chunk.window.start:.2f}-{chunk.window.end:.2f}]"
        segments.append(f"{stamp} {chunk.text}".strip())
    return " ".join(segment for segment in segments if segment).strip()


__all__ = ["ChunkWindow", "ChunkTranscript", "generate_windows", "concat_transcripts"]
