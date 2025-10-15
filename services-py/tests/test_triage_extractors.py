from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable, Mapping

import pytest

from triage_dataset.extractors import (
    extract_clinician_outcomes,
    extract_portal_submissions,
    extract_safety_gate_records,
)


def _write_jsonl(path: Path, rows: Iterable[Mapping[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row))
            handle.write("\n")


def test_extract_portal_submissions_filters_date(tmp_path: Path) -> None:
    submissions_path = tmp_path / "raw" / "submissions.jsonl"
    rows = [
        {
            "submissionId": "sub-a",
            "submittedAt": "2025-02-10T10:00:00Z",
            "practiceId": "prac-1",
            "consentScope": "training_allowed",
            "channel": "web",
            "narrative": "Chest pain",
            "patient": {"id": "pa-1", "locale": "en-GB"},
        },
        {
            "submissionId": "sub-b",
            "submittedAt": "2025-01-01T09:00:00Z",
            "practiceId": "prac-2",
            "consentScope": "training_allowed",
            "channel": "web",
            "narrative": "Headache",
            "patient": {"id": "pa-2"},
        },
    ]
    _write_jsonl(submissions_path, rows)

    since = datetime.fromisoformat("2025-02-01T00:00:00+00:00")
    until = datetime.fromisoformat("2025-02-28T23:59:59+00:00")

    extracted = extract_portal_submissions([submissions_path], since=since, until=until)

    assert len(extracted) == 1
    record = extracted[0]
    assert record["submissionId"] == "sub-a"
    assert record["patientKey"] == "pa-1"
    assert record["narrative"] == "Chest pain"


def test_extract_safety_gate_records(tmp_path: Path) -> None:
    safety_path = tmp_path / "raw" / "safety.jsonl"
    rows = [
        {
            "submissionId": "sub-a",
            "decisionAt": "2025-02-10T10:05:00Z",
            "decision": "DIVERTED",
            "reason": "red_flag:chest_pain",
            "redFlags": ["chest_pain"],
            "classifier": {"score": 0.92, "version": "clf-1"},
            "acuity": {"score": 0.81, "modelVersion": "acuity-1"},
            "labels": {"emergency": True},
        }
    ]
    _write_jsonl(safety_path, rows)

    extracted = extract_safety_gate_records([safety_path])
    assert len(extracted) == 1
    record = extracted[0]
    assert record["submissionId"] == "sub-a"
    safety = record["safetyGate"]
    assert safety["decision"] == "DIVERTED"
    assert safety["acuity"]["score"] == 0.81
    assert record["safetyGateDecision"] == "DIVERTED"


def test_extract_clinician_outcomes(tmp_path: Path) -> None:
    audit_path = tmp_path / "raw" / "audit.jsonl"
    rows = [
        {
            "submissionId": "sub-a",
            "recordedAt": "2025-02-10T11:00:00Z",
            "disposition": "er_transfer",
            "override": False,
            "notes": "Confirmed red flag.",
            "emergency": True,
            "priorityBand": "critical",
            "resolutionMinutes": 12,
            "followUpRequired": True,
        }
    ]
    _write_jsonl(audit_path, rows)

    extracted = extract_clinician_outcomes([audit_path])
    assert len(extracted) == 1
    record = extracted[0]
    assert record["submissionId"] == "sub-a"
    assert record["clinicianDisposition"] == "er_transfer"
    assert record["labels"]["priorityBand"] == "critical"
    assert record["followUpRequired"] is True


def test_extract_inputs_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw_dir = tmp_path / "raw"
    submissions_path = raw_dir / "submissions.jsonl"
    safety_path = raw_dir / "safety.jsonl"
    audit_path = raw_dir / "audit.jsonl"

    _write_jsonl(
        submissions_path,
        [
            {
                "submissionId": "sub-a",
                "submittedAt": "2025-02-10T10:00:00Z",
                "practiceId": "prac-1",
                "consentScope": "training_allowed",
                "channel": "web",
                "narrative": "Chest pain",
                "patient": {"id": "pa-1"},
            }
        ],
    )
    _write_jsonl(
        safety_path,
        [
            {
                "submissionId": "sub-a",
                "decisionAt": "2025-02-10T10:05:00Z",
                "decision": "DIVERTED",
                "reason": "red_flag:chest_pain",
            }
        ],
    )
    _write_jsonl(
        audit_path,
        [
            {
                "submissionId": "sub-a",
                "recordedAt": "2025-02-10T11:00:00Z",
                "disposition": "er_transfer",
                "override": False,
                "emergency": True,
            }
        ],
    )

    output_dir = tmp_path / "out"
    script = ROOT_SCRIPT()
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    services_dir = Path(__file__).resolve().parents[1]
    env["PYTHONPATH"] = f"{services_dir}:{existing}" if existing else str(services_dir)

    config_path = tmp_path / "sources.json"
    config_path.write_text(
        json.dumps(
            {
                "submissions": [{"type": "local", "path": str(submissions_path)}],
                "safetyGate": [{"type": "local", "path": str(safety_path)}],
                "clinician": [{"type": "local", "path": str(audit_path)}],
            }
        ),
        encoding="utf-8",
    )

    cmd = [
        sys.executable,
        str(script),
        "--config",
        str(config_path),
        "--output-dir",
        str(output_dir),
    ]

    completed = subprocess.run(cmd, env=env, check=True, capture_output=True, text=True)
    summary = json.loads(completed.stdout)
    assert summary["submissions"] == 1
    assert summary["safetyGate"] == 1

    submissions_out = output_dir / "triage_submissions.jsonl"
    assert submissions_out.exists()
    payload = list(_iter_jsonl(submissions_out))
    assert payload and payload[0]["submissionId"] == "sub-a"


def test_load_source_config_yaml(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    try:
        import yaml  # type: ignore
    except Exception:
        pytest.skip("PyYAML not installed")

    raw_dir = tmp_path / "raw"
    submissions_path = raw_dir / "submissions.jsonl"
    _write_jsonl(
        submissions_path,
        [
            {
                "submissionId": "sub-config",
                "submittedAt": "2025-02-10T10:00:00Z",
                "consentScope": "training_allowed",
                "narrative": "Narrative",
                "patient": {"id": "pc-1"},
            }
        ],
    )

    config_path = tmp_path / "sources.yaml"
    config_path.write_text(
        yaml.safe_dump({"submissions": [{"type": "local", "path": str(submissions_path)}]}),
        encoding="utf-8",
    )

    script = ROOT_SCRIPT()
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    services_dir = Path(__file__).resolve().parents[1]
    env["PYTHONPATH"] = f"{services_dir}:{existing}" if existing else str(services_dir)
    output_dir = tmp_path / "out"
    cmd = [
        sys.executable,
        str(script),
        "--config",
        str(config_path),
        "--output-dir",
        str(output_dir),
    ]
    subprocess.run(cmd, env=env, check=True, capture_output=True, text=True)
    submissions_out = output_dir / "triage_submissions.jsonl"
    payload = list(_iter_jsonl(submissions_out))
    assert payload and payload[0]["submissionId"] == "sub-config"


def test_run_pipeline_script(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw_dir = tmp_path / "raw"
    submissions_path = raw_dir / "submissions.jsonl"
    safety_path = raw_dir / "safety.jsonl"
    audit_path = raw_dir / "audit.jsonl"

    _write_jsonl(
        submissions_path,
        [
            {
                "submissionId": "sub-pipeline",
                "submittedAt": "2025-02-10T10:00:00Z",
                "practiceId": "prac-1",
                "consentScope": "training_allowed",
                "channel": "web",
                "narrative": "Chest tightness",
                "patient": {"id": "p-1"},
            }
        ],
    )
    _write_jsonl(
        safety_path,
        [
            {
                "submissionId": "sub-pipeline",
                "decisionAt": "2025-02-10T10:05:00Z",
                "decision": "DIVERTED",
                "reason": "red_flag:chest_pain",
            }
        ],
    )
    _write_jsonl(
        audit_path,
        [
            {
                "submissionId": "sub-pipeline",
                "recordedAt": "2025-02-10T11:00:00Z",
                "disposition": "er_transfer",
                "emergency": True,
            }
        ],
    )

    config_path = tmp_path / "sources.json"
    config_path.write_text(
        json.dumps(
            {
                "submissions": [{"type": "local", "path": str(submissions_path)}],
                "safetyGate": [{"type": "local", "path": str(safety_path)}],
                "clinician": [{"type": "local", "path": str(audit_path)}],
            }
        ),
        encoding="utf-8",
    )

    script = ROOT_PIPELINE_SCRIPT()
    env = os.environ.copy()
    services_dir = Path(__file__).resolve().parents[1]
    env["PYTHONPATH"] = f"{services_dir}:{env.get('PYTHONPATH','')}".strip(":")
    env["TRIAGE_DATASET_SALT"] = "unit-salt"
    output_dir = tmp_path / "datasets"
    cmd = [
        sys.executable,
        str(script),
        "--config",
        str(config_path),
        "--output-dir",
        str(output_dir),
        "--dataset-version",
        "vtest",
        "--deident-version",
        "deid-test",
    ]
    subprocess.run(cmd, env=env, check=True, capture_output=True, text=True)
    dataset_file = output_dir / "vtest" / "dataset.jsonl"
    assert dataset_file.exists()
    rows = list(_iter_jsonl(dataset_file))
    assert rows and rows[0]["submissionId"] == "sub-pipeline"



def _iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def ROOT_SCRIPT() -> Path:
    return Path(__file__).resolve().parents[2] / "scripts" / "triage_dataset" / "extract_inputs.py"


def ROOT_PIPELINE_SCRIPT() -> Path:
    return Path(__file__).resolve().parents[2] / "scripts" / "triage_dataset" / "run_pipeline.py"
