from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Iterable, Mapping, MutableMapping, Sequence

Row = Mapping[str, object]

EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_PATTERN = re.compile(r"\b(?:\+?\d[\d\s\-().]{7,}\d)\b")
URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)
NHS_PATTERN = re.compile(r"\b\d{4}\s?\d{6}\b")


def _normalize_salt(salt: str) -> str:
    trimmed = salt.strip()
    if not trimmed:
        raise ValueError("salt must be a non-empty string")
    return trimmed


def _hash_value(value: str, salt: str) -> str:
    digest = hashlib.sha256()
    digest.update(salt.encode("utf-8"))
    digest.update(value.encode("utf-8"))
    return digest.hexdigest()


def _scrub_text(value: str) -> str:
    scrubbed = value
    scrubbed = EMAIL_PATTERN.sub("<EMAIL>", scrubbed)
    scrubbed = PHONE_PATTERN.sub("<PHONE>", scrubbed)
    scrubbed = URL_PATTERN.sub("<URL>", scrubbed)
    scrubbed = NHS_PATTERN.sub("<NHS_NUMBER>", scrubbed)
    return scrubbed


@dataclass
class SanitizerConfig:
    salt: str
    redact_fields: Sequence[str] = field(default_factory=tuple)
    attachment_url_placeholder: str = "<REDACTED>"

    def normalized_salt(self) -> str:
        return _normalize_salt(self.salt)


def build_row_sanitizer(config: SanitizerConfig):
    salt = config.normalized_salt()
    redact_set = set(config.redact_fields)

    def sanitize(row: Row) -> MutableMapping[str, object]:
        cleaned: MutableMapping[str, object] = dict(row)

        if isinstance(cleaned.get("practiceId"), str):
            cleaned["practiceIdHashed"] = _hash_value(cleaned["practiceId"], salt)
            cleaned.pop("practiceId", None)

        if isinstance(cleaned.get("patientKey"), str):
            cleaned["patientKeyHashed"] = _hash_value(cleaned["patientKey"], salt)
            cleaned.pop("patientKey", None)

        narrative = cleaned.get("narrative")
        if isinstance(narrative, str):
            cleaned["narrative"] = _scrub_text(narrative)

        attachments = cleaned.get("attachments")
        if isinstance(attachments, Iterable):
            sanitized_attachments = []
            for attachment in attachments:
                if not isinstance(attachment, Mapping):
                    continue
                entry = dict(attachment)
                if "url" in entry:
                    entry["url"] = config.attachment_url_placeholder
                sanitized_attachments.append(entry)
            cleaned["attachments"] = sanitized_attachments

        for field in redact_set:
            if field in cleaned:
                cleaned.pop(field, None)

        return cleaned

    return sanitize
