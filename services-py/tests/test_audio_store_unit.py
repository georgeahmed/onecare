from datetime import datetime, timedelta, timezone

from scribe_service.audio_store import (
    AudioRetentionConfig,
    AudioStore,
    create_audio_store,
    load_audio_retention_config,
)


def test_audio_store_should_store_binary_mode():
    store = AudioStore(AudioRetentionConfig(store_audio="binary", retention_days=7))

    assert store.should_store() is True
    record = store.record(encounter_id="enc-1", audio_url="s3://bucket/audio.wav")
    assert record is not None
    assert store.list_references()[0].encounter_id == "enc-1"


def test_audio_store_respects_retention_window(monkeypatch):
    store = AudioStore(AudioRetentionConfig(store_audio="binary", retention_days=1))
    now = datetime(2025, 1, 2, 12, tzinfo=timezone.utc)

    old_record = store.record(
        encounter_id="enc-old",
        audio_url="s3://old.wav",
        stored_at=now - timedelta(days=2, hours=1),
    )
    new_record = store.record(
        encounter_id="enc-new",
        audio_url="s3://new.wav",
        stored_at=now - timedelta(hours=6),
    )

    assert old_record is not None and new_record is not None
    remaining_after_record = store.list_references()
    assert [ref.encounter_id for ref in remaining_after_record] == ["enc-new"]

    removed = store.purge_expired(now=now)
    assert removed == 0
    remaining = store.list_references()
    assert len(remaining) == 1
    assert remaining[0].encounter_id == "enc-new"


def test_audio_store_ignores_blank_references():
    store = AudioStore(AudioRetentionConfig(store_audio="binary", retention_days=7))

    none_id = store.record(encounter_id="   ", audio_url="s3://valid.wav")
    none_url = store.record(encounter_id="enc-valid", audio_url="  ")

    assert none_id is None
    assert none_url is None
    assert store.list_references() == []


def test_audio_store_skips_storage_when_retention_zero():
    store = AudioStore(AudioRetentionConfig(store_audio="binary", retention_days=0))

    record = store.record(encounter_id="enc-zero", audio_url="s3://bucket/audio.wav")

    assert record is None
    assert store.list_references() == []


def test_load_audio_retention_config_prefers_env_over_file(monkeypatch, tmp_path):
    config_file = tmp_path / "audio.yml"
    config_file.write_text(
        """
ambient_scribe:
  store_audio: binary
  retention_days: 30
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("SCRIBE_STORE_AUDIO", "none")
    monkeypatch.setenv("SCRIBE_AUDIO_RETENTION_DAYS", "5")

    config = load_audio_retention_config(config_path=config_file)

    assert config.store_audio == "none"
    assert config.retention_days == 5


def test_create_audio_store_uses_config_file(tmp_path, monkeypatch):
    config_path = tmp_path / "audio.yml"
    config_path.write_text(
        """
ambient_scribe:
  store_audio: binary
  retention_days: 14
""",
        encoding="utf-8",
    )
    monkeypatch.delenv("SCRIBE_STORE_AUDIO", raising=False)
    monkeypatch.delenv("SCRIBE_AUDIO_RETENTION_DAYS", raising=False)

    store = create_audio_store(config_path=config_path)

    assert store.should_store() is True
    assert store.config.retention_days == 14
