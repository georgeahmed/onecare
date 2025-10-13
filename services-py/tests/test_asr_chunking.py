import pytest

from scribe_service.asr_chunking import (
    ChunkTranscript,
    generate_windows,
    concat_transcripts,
)


def test_generate_windows_with_overlap():
    windows = generate_windows(95.0, chunk_seconds=30.0, overlap_seconds=1.0)

    assert len(windows) == 4
    assert windows[0].start == pytest.approx(0.0)
    assert windows[0].end == pytest.approx(30.0)
    assert windows[1].start == pytest.approx(29.0)
    assert windows[1].end == pytest.approx(59.0)
    assert windows[-1].end == pytest.approx(95.0)


def test_concat_transcripts_orders_by_start():
    windows = generate_windows(60.0, chunk_seconds=30.0, overlap_seconds=5.0)
    chunks = [
        ChunkTranscript(window=windows[1], text="[SPEAKER_2] part 2"),
        ChunkTranscript(window=windows[0], text="[SPEAKER_1] part 1"),
    ]

    combined = concat_transcripts(chunks)

    assert combined.startswith("[0.00-30.00] [SPEAKER_1] part 1")
    assert "[25.00-55.00] [SPEAKER_2] part 2" in combined


def test_generate_windows_validates_params():
    with pytest.raises(ValueError):
        generate_windows(-1.0, chunk_seconds=30.0)
    with pytest.raises(ValueError):
        generate_windows(60.0, chunk_seconds=0.0)
    with pytest.raises(ValueError):
        generate_windows(60.0, chunk_seconds=30.0, overlap_seconds=40.0)
