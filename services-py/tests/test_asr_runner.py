import pytest

from scribe_service.asr_runner import (
    TranscriptionChunk,
    TranscriptionResult,
    load_model,
    transcribe,
)


def test_load_model_creates_cache_structure(tmp_path):
    model = load_model("base", cache_dir=tmp_path)

    assert model.name == "base"
    assert model.path.exists()
    assert model.path.is_dir()
    metadata_file = model.path / "model.json"
    assert metadata_file.exists()


def test_transcribe_splits_long_audio(tmp_path):
    model = load_model(cache_dir=tmp_path)
    audio_ref = {"url": "s3://bucket/call.wav", "durationSeconds": 95}

    result = transcribe(audio_ref, model=model, chunk_seconds=30)

    assert isinstance(result, TranscriptionResult)
    assert result.model_name == model.name
    assert len(result.chunks) == 4
    assert all(isinstance(chunk, TranscriptionChunk) for chunk in result.chunks)
    assert result.chunks[0].start == pytest.approx(0.0)
    assert result.chunks[-1].end == pytest.approx(95.0)
    speakers = {chunk.speaker for chunk in result.chunks}
    assert speakers
    assert all(speaker.startswith("SPEAKER_") for speaker in speakers)
    assert result.text.startswith("[0.00-30.00]")
    assert "[29.00-59.00]" in result.text
    assert "[58.00-88.00]" in result.text
    assert "[87.00-95.00]" in result.text
    assert result.text.count("chunk=") == 4
    assert result.text.count("[SPEAKER_") == 4


def test_transcribe_rejects_non_positive_window():
    with pytest.raises(ValueError):
        transcribe("audio.wav", chunk_seconds=0)
