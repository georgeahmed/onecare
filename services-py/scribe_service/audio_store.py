from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    yaml = None

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "nhs_gp_defaults.yaml"
DEFAULT_STORE_MODE = "none"


@dataclass(frozen=True)
class AudioRetentionConfig:
    store_audio: str = DEFAULT_STORE_MODE
    retention_days: int = 0


@dataclass(frozen=True)
class AudioReference:
    encounter_id: str
    audio_url: str
    stored_at: datetime


class AudioStore:
    """In-memory audio reference store with basic retention enforcement."""

    def __init__(self, config: AudioRetentionConfig) -> None:
        self._config = config
        self._records: list[AudioReference] = []

    @property
    def config(self) -> AudioRetentionConfig:
        return self._config

    def should_store(self) -> bool:
        return self._config.store_audio.lower() == "binary"

    def record(self, *, encounter_id: str, audio_url: str, stored_at: Optional[datetime] = None) -> Optional[AudioReference]:
        if not self.should_store():
            return None

        encounter = encounter_id.strip()
        location = audio_url.strip()
        if not encounter or not location:
            return None

        timestamp = stored_at or datetime.now(timezone.utc)
        reference = AudioReference(encounter_id=encounter, audio_url=location, stored_at=timestamp)
        self._records.append(reference)
        self.purge_expired(now=timestamp)
        return reference

    def list_references(self) -> list[AudioReference]:
        return list(self._records)

    def purge_expired(self, *, now: Optional[datetime] = None) -> int:
        """Remove references older than the configured retention window."""

        retention = max(self._config.retention_days, 0)
        if retention == 0:
            removed = len(self._records)
            self._records = []
            return removed

        now = now or datetime.now(timezone.utc)
        cutoff = now - timedelta(days=retention)
        before = len(self._records)
        self._records = [record for record in self._records if record.stored_at >= cutoff]
        return before - len(self._records)


def create_audio_store(config_path: Optional[str | Path] = None) -> AudioStore:
    config = load_audio_retention_config(config_path=config_path)
    return AudioStore(config)


def load_audio_retention_config(*, config_path: Optional[str | Path] = None) -> AudioRetentionConfig:
    env_store = os.getenv("SCRIBE_STORE_AUDIO")
    env_retention = os.getenv("SCRIBE_AUDIO_RETENTION_DAYS")

    config_data: dict[str, Any] = {}
    file_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    if yaml is not None and file_path.exists():
        try:
            with file_path.open(encoding="utf-8") as handle:
                raw = yaml.safe_load(handle) or {}
                if isinstance(raw, dict):
                    config_data = raw
        except Exception:
            config_data = {}

    ambient_cfg = config_data.get("ambient_scribe", {}) if isinstance(config_data, dict) else {}
    store_value = _determine_store_mode(env_store, ambient_cfg)
    retention_value = _determine_retention_days(env_retention, ambient_cfg)

    return AudioRetentionConfig(store_audio=store_value, retention_days=retention_value)


def _determine_store_mode(env_value: Optional[str], config_section: Any) -> str:
    if env_value:
        return env_value.strip().lower()
    if isinstance(config_section, dict):
        value = config_section.get("store_audio")
        if isinstance(value, str):
            return value.strip().lower()
    return DEFAULT_STORE_MODE


def _determine_retention_days(env_value: Optional[str], config_section: Any) -> int:
    if env_value:
        parsed = _parse_positive_int(env_value)
        if parsed is not None:
            return parsed
    if isinstance(config_section, dict):
        candidate = config_section.get("retention_days")
        parsed = _parse_positive_int(candidate)
        if parsed is not None:
            return parsed
    return 0


def _parse_positive_int(value: Any) -> Optional[int]:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


__all__ = [
    "AudioStore",
    "AudioReference",
    "AudioRetentionConfig",
    "create_audio_store",
    "load_audio_retention_config",
]
