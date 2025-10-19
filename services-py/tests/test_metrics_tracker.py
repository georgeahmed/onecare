from safety_gate_service.metrics import LatencyMetrics


def test_latency_metrics_sliding_window_recomputes_counts() -> None:
    tracker = LatencyMetrics(window_size=2, buckets=[100.0])

    tracker.observe(40.0)
    tracker.observe(80.0)
    tracker.observe(90.0)

    # Only the most recent two samples should be retained in the sliding window.
    metrics_text = tracker.render_prometheus()
    assert "safety_gate_latency_ms_count 2" in metrics_text
    assert "safety_gate_latency_ms_sum 170.000000" in metrics_text
