import re

from fastapi.testclient import TestClient

from scribe_service.main import (
    _DURATION_HISTOGRAM,
    _REQUEST_COUNTER,
    _SUCCESS_COUNTER,
    app,
)


def test_metrics_endpoint_reports_counters() -> None:
    _REQUEST_COUNTER.clear()
    _SUCCESS_COUNTER.clear()
    _DURATION_HISTOGRAM.clear()

    client = TestClient(app)

    health_response = client.get("/health")
    assert health_response.status_code == 200

    metrics_response = client.get("/metrics", headers={"x-correlation-id": "metrics-test"})
    assert metrics_response.status_code == 200
    assert metrics_response.headers.get("x-correlation-id") == "metrics-test"

    body = metrics_response.text
    requests_line = next((line for line in body.splitlines() if line.startswith("http_server_requests_total{")), "")
    success_line = next((line for line in body.splitlines() if line.startswith("http_server_success_total{")), "")

    assert "service=\"scribe\"" in requests_line
    assert "method=\"GET\"" in requests_line
    assert "route=\"/health\"" in requests_line
    assert "status=\"200\"" in requests_line
    assert requests_line.rstrip().endswith((" 1", " 1.0"))

    assert "service=\"scribe\"" in success_line
    assert "route=\"/health\"" in success_line
    assert success_line.rstrip().endswith((" 1", " 1.0"))
