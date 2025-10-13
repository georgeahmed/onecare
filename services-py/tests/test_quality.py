import pytest

from scribe_service.quality import QualityFlags, evaluate_quality


def test_evaluate_quality_with_confidence_flags_low_confidence():
    flags = evaluate_quality(
        "sample text with words",
        chunk_confidences=[0.4, 0.45, 0.5],
        chunk_texts=["chunk one"],
    )

    assert flags.low_confidence is True
    assert "avg_confidence" in ";".join(flags.notes)
    assert flags.silence_detected is False


def test_evaluate_quality_detects_silence_token():
    flags = evaluate_quality(
        "[silence] silence here",
        chunk_confidences=[0.9],
        chunk_texts=[],
    )

    assert flags.silence_detected is True
    assert flags.low_confidence is False


def test_evaluate_quality_empty_transcript_marked_low_confidence():
    flags = evaluate_quality(
        "",
        chunk_confidences=None,
        chunk_texts=["[silence]"],
    )

    assert flags.low_confidence is True
    assert flags.silence_detected is True
