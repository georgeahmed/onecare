from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from fastapi.testclient import TestClient

from safety_gate_service.main import app


def _load_samples(path: Path) -> list[dict[str, object]]:
    samples: list[dict[str, object]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            samples.append(json.loads(line))
    if not samples:
        raise SystemExit("no samples found")
    return samples


def profile(samples: list[dict[str, object]], iterations: int) -> dict[str, float]:
    latencies: list[float] = []
    with TestClient(app) as client:
        for _ in range(iterations):
            for record in samples:
                payload = {
                    "practiceId": record.get("practiceId", "practice-1"),
                    "patient": {"id": record.get("patientId", "pt-1")},
                    "narrative": record["text"],
                    "channel": record.get("channel", "web"),
                }
                start = time.perf_counter()
                response = client.post("/analyze", json=payload, headers={"authorization": "Bearer test-safety-key", "x-auth-scope": "safety:analyze"})
                response.raise_for_status()
                latencies.append((time.perf_counter() - start) * 1000.0)
    latencies.sort()
    count = len(latencies)
    p95_index = int(0.95 * count) - 1
    return {
        "count": count,
        "meanMs": statistics.mean(latencies) if latencies else 0.0,
        "medianMs": statistics.median(latencies) if latencies else 0.0,
        "p95Ms": latencies[max(p95_index, 0)] if latencies else 0.0,
        "maxMs": max(latencies) if latencies else 0.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Profile Safety Gate analyze endpoint")
    parser.add_argument("--samples", type=Path, default=Path("services-py/safety_gate_service/data/golden_set.v1.jsonl"))
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--output", type=Path, default=Path("artifacts/eval/safety_gate_profile.json"))
    args = parser.parse_args()

    samples = _load_samples(args.samples)
    metrics = profile(samples, args.iterations)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":  # pragma: no cover - CLI helper
    main()
