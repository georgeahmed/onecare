from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Iterator, List, Mapping, MutableMapping, Sequence


ISO_Z_SUFFIX = "Z"


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed.endswith(ISO_Z_SUFFIX):
        trimmed = trimmed[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(trimmed)
    except ValueError:
        return None


def _within_range(ts: datetime | None, *, since: datetime | None, until: datetime | None) -> bool:
    if ts is None:
        return True
    if since and ts < since:
        return False
    if until and ts > until:
        return False
    return True


def _iter_jsonl(paths: Sequence[Path]) -> Iterator[Mapping[str, object]]:
    for path in paths:
        if path.is_dir():
            for item in sorted(path.glob("*.jsonl")):
                yield from _iter_jsonl([item])
            continue
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    doc = json.loads(line)
                    if isinstance(doc, Mapping):
                        yield doc
                except json.JSONDecodeError:
                    continue


def _collect(paths: Sequence[Path]) -> List[Mapping[str, object]]:
    return list(_iter_jsonl(paths))


def extract_portal_submissions(
    sources: Sequence[Path],
    *,
    since: datetime | None = None,
    until: datetime | None = None,
) -> List[MutableMapping[str, object]]:
    records: List[MutableMapping[str, object]] = []
    for raw in _collect(sources):
        submission_id = raw.get("submissionId")
        if not isinstance(submission_id, str):
            continue
        submitted_at = _parse_iso(_coerce_str(raw.get("submittedAt")))
        if not _within_range(submitted_at, since=since, until=until):
            continue
        record: MutableMapping[str, object] = {
            "submissionId": submission_id,
            "submittedAt": _coerce_str(raw.get("submittedAt")),
            "practiceId": raw.get("practiceId"),
            "consentScope": raw.get("consentScope"),
            "channel": raw.get("channel"),
            "narrative": raw.get("narrative"),
        }
        patient = raw.get("patient")
        if isinstance(patient, Mapping):
            patient_id = patient.get("id")
            if isinstance(patient_id, str):
                record["patientKey"] = patient_id
            for key in ("dob", "locale", "sex"):
                value = patient.get(key)
                if value is not None:
                    record[f"patient{key.capitalize()}"] = value
        if isinstance(raw.get("attachments"), list):
            record["attachments"] = raw.get("attachments")
        features = raw.get("features")
        if isinstance(features, Mapping):
            record["features"] = features
        records.append(record)
    return records


def extract_safety_gate_records(
    sources: Sequence[Path],
    *,
    since: datetime | None = None,
    until: datetime | None = None,
) -> List[MutableMapping[str, object]]:
    records: List[MutableMapping[str, object]] = []
    for raw in _collect(sources):
        submission_id = raw.get("submissionId")
        if not isinstance(submission_id, str):
            continue
        decision_at = _parse_iso(_coerce_str(raw.get("decisionAt") or raw.get("evaluatedAt")))
        if not _within_range(decision_at, since=since, until=until):
            continue
        red_flags = raw.get("redFlags")
        classifier = raw.get("classifier") if isinstance(raw.get("classifier"), Mapping) else {}
        acuity = raw.get("acuity") if isinstance(raw.get("acuity"), Mapping) else {}
        record: MutableMapping[str, object] = {
            "submissionId": submission_id,
            "safetyGate": {
                "decision": raw.get("decision"),
                "reason": raw.get("reason"),
                "redFlags": red_flags if isinstance(red_flags, list) else [],
                "classifierScore": classifier.get("score"),
                "classifierVersion": classifier.get("version"),
                "acuity": {
                    "score": acuity.get("score"),
                    "modelVersion": acuity.get("modelVersion"),
                },
            },
            "safetyGateDecision": raw.get("decision"),
            "safetyGateReason": raw.get("reason"),
            "safetyGateDecisionAt": _coerce_str(raw.get("decisionAt") or raw.get("evaluatedAt")),
        }
        if isinstance(raw.get("labels"), Mapping):
            record["labels"] = raw["labels"]  # type: ignore[index]
        records.append(record)
    return records


def extract_clinician_outcomes(
    sources: Sequence[Path],
    *,
    since: datetime | None = None,
    until: datetime | None = None,
) -> List[MutableMapping[str, object]]:
    records: List[MutableMapping[str, object]] = []
    for raw in _collect(sources):
        submission_id = raw.get("submissionId")
        if not isinstance(submission_id, str):
            continue
        recorded_at = _parse_iso(_coerce_str(raw.get("recordedAt")))
        if not _within_range(recorded_at, since=since, until=until):
            continue
        disposition = raw.get("disposition")
        override = raw.get("override")
        record: MutableMapping[str, object] = {
            "submissionId": submission_id,
            "clinicianDisposition": disposition,
            "clinicianOverride": bool(override),
            "overrideNotes": raw.get("notes"),
            "labels": {},
        }
        labels = record["labels"]  # type: ignore[assignment]
        emergency = raw.get("emergency")
        if emergency is not None:
            labels["emergency"] = bool(emergency)
        priority = raw.get("priorityBand") or raw.get("priority")
        if priority is not None:
            labels["priorityBand"] = priority
        resolution_minutes = raw.get("resolutionMinutes")
        if resolution_minutes is not None:
            record["resolutionTimeMinutes"] = resolution_minutes
        follow_up = raw.get("followUpRequired")
        if follow_up is not None:
            record["followUpRequired"] = bool(follow_up)
        records.append(record)
    return records


def _coerce_str(value: object) -> str | None:
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    return None

