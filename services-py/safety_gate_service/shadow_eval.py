from __future__ import annotations

import logging
import random
import threading
import time
from collections import deque
from dataclasses import dataclass
from statistics import mean
from typing import Any, Callable, Deque, Dict, Optional, Protocol

logger = logging.getLogger(__name__)


class Predictor(Protocol):
    def __call__(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        ...


@dataclass(frozen=True)
class ShadowSample:
    timestamp_ms: float
    primary_latency_ms: float
    candidate_latency_ms: float
    disagreement: bool
    score_delta: Optional[float]


class ShadowWindow:
    def __init__(self, max_samples: int = 512) -> None:
        self._samples: Deque[ShadowSample] = deque(maxlen=max_samples)
        self._lock = threading.Lock()

    def record(self, sample: ShadowSample) -> None:
        with self._lock:
            self._samples.append(sample)

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            if not self._samples:
                return {
                    "sampleCount": 0,
                    "agreement": 1.0,
                    "latency": {"primaryP95": None, "candidateP95": None, "deltaMean": None},
                }
            samples = list(self._samples)

        disagreements = sum(1 for item in samples if item.disagreement)
        primary_latencies = sorted(item.primary_latency_ms for item in samples)
        candidate_latencies = sorted(item.candidate_latency_ms for item in samples)
        latency_delta = [item.candidate_latency_ms - item.primary_latency_ms for item in samples]
        score_deltas = [item.score_delta for item in samples if item.score_delta is not None]

        def _p95(values: list[float]) -> Optional[float]:
            if not values:
                return None
            index = max(0, int(round(0.95 * (len(values) - 1))))
            return float(values[index])

        data: Dict[str, Any] = {
            "sampleCount": len(samples),
            "agreement": 1 - disagreements / len(samples),
            "latency": {
                "primaryP95": _p95(primary_latencies),
                "candidateP95": _p95(candidate_latencies),
                "deltaMean": mean(latency_delta) if latency_delta else 0.0,
            },
        }
        if score_deltas:
            data["scoreDeltaMean"] = mean(score_deltas)
        return data


class ShadowEvaluator:
    def __init__(
        self,
        primary_predictor: Predictor,
        candidate_predictor: Predictor,
        *,
        sample_rate: float = 0.05,
        rng: Callable[[], float] | None = None,
        window: ShadowWindow | None = None,
    ) -> None:
        if sample_rate < 0 or sample_rate > 1:
            raise ValueError("sample_rate must be within [0, 1]")
        self._primary = primary_predictor
        self._candidate = candidate_predictor
        self._sample_rate = sample_rate
        self._rng = rng or random.random
        self._window = window or ShadowWindow()

    def evaluate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        start_primary = time.perf_counter()
        primary_response = self._primary(payload)
        primary_latency_ms = (time.perf_counter() - start_primary) * 1000

        if self._sample_rate <= 0 or self._rng() > self._sample_rate:
            return primary_response

        candidate_latency_ms = 0.0
        candidate_response: Optional[Dict[str, Any]] = None
        try:
            start_candidate = time.perf_counter()
            candidate_response = self._candidate(payload)
            candidate_latency_ms = (time.perf_counter() - start_candidate) * 1000
        except Exception as error:  # pragma: no cover - defensive guard
            logger.warning("shadow evaluation failed", exc_info=error)
            candidate_response = None

        disagreement = False
        score_delta: Optional[float] = None

        if candidate_response is not None:
            primary_outcome = primary_response.get("outcome")
            candidate_outcome = candidate_response.get("outcome")
            disagreement = primary_outcome != candidate_outcome

            primary_score = _extract_score(primary_response)
            candidate_score = _extract_score(candidate_response)
            if primary_score is not None and candidate_score is not None:
                score_delta = candidate_score - primary_score

        self._window.record(
            ShadowSample(
                timestamp_ms=time.time() * 1000,
                primary_latency_ms=primary_latency_ms,
                candidate_latency_ms=candidate_latency_ms,
                disagreement=disagreement,
                score_delta=score_delta,
            )
        )

        if disagreement:
            logger.info(
                "shadow disagreement detected",
                extra={
                    "shadowOutcome": candidate_response.get("outcome") if candidate_response else None,
                    "primaryOutcome": primary_response.get("outcome"),
                    "scoreDelta": score_delta,
                },
            )

        return primary_response

    def metrics(self) -> Dict[str, Any]:
        return self._window.snapshot()

    def render_prometheus(self, service: str = "safety-gate") -> str:
        snapshot = self.metrics()
        sample_count = snapshot.get("sampleCount", 0)
        agreement = snapshot.get("agreement", 1.0)
        latency = snapshot.get("latency", {})
        primary_p95 = latency.get("primaryP95") or 0.0
        candidate_p95 = latency.get("candidateP95") or 0.0
        delta_mean = latency.get("deltaMean") or 0.0

        lines = [
            "# HELP shadow_evaluator_sample_count Number of mirrored evaluations processed",
            "# TYPE shadow_evaluator_sample_count counter",
            f'shadow_evaluator_sample_count{{service="{service}"}} {sample_count}',
            "# HELP shadow_evaluator_agreement_ratio Agreement ratio between primary and shadow predictions",
            "# TYPE shadow_evaluator_agreement_ratio gauge",
            f'shadow_evaluator_agreement_ratio{{service="{service}"}} {agreement}',
            "# HELP shadow_evaluator_latency_p95 Shadow latency p95 in milliseconds",
            "# TYPE shadow_evaluator_latency_p95 gauge",
            f'shadow_evaluator_latency_p95{{service="{service}",role="primary"}} {primary_p95}',
            f'shadow_evaluator_latency_p95{{service="{service}",role="candidate"}} {candidate_p95}',
            "# HELP shadow_evaluator_latency_delta_mean Mean latency delta (candidate - primary) in milliseconds",
            "# TYPE shadow_evaluator_latency_delta_mean gauge",
            f'shadow_evaluator_latency_delta_mean{{service="{service}"}} {delta_mean}',
        ]

        score_delta_mean = snapshot.get("scoreDeltaMean")
        if score_delta_mean is not None:
            lines.extend(
                [
                    "# HELP shadow_evaluator_score_delta_mean Mean score delta between candidate and primary",
                    "# TYPE shadow_evaluator_score_delta_mean gauge",
                    f'shadow_evaluator_score_delta_mean{{service="{service}"}} {score_delta_mean}',
                ]
            )

        return "\n".join(lines) + "\n"


def _extract_score(response: Dict[str, Any]) -> Optional[float]:
    score = response.get("score") or response.get("probEmergency")
    if isinstance(score, (int, float)):
        return float(score)
    return None
