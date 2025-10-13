import pytest

from scribe_service.diarize import diarize


def test_diarize_alternates_speakers():
    result = diarize({"url": "audio.wav", "durationSeconds": 60}, segment_seconds=15, max_speakers=2)

    assert len(result.segments) == 4
    assert result.speaker_count == 2
    assert result.segments[0].speaker == "SPEAKER_1"
    assert result.segments[1].speaker == "SPEAKER_2"
    assert result.segments[-1].end == pytest.approx(60.0)


def test_diarize_handles_unknown_duration():
    result = diarize("audio.wav")

    assert len(result.segments) == 1
    assert result.segments[0].speaker == "SPEAKER_1"
    assert result.speaker_count == 1


def test_diarize_validates_arguments():
    with pytest.raises(ValueError):
        diarize({"durationSeconds": 10}, segment_seconds=0)
    with pytest.raises(ValueError):
        diarize({"durationSeconds": 10}, max_speakers=0)
