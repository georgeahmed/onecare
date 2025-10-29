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
    assert 'http_server_requests_total{service="scribe",method="GET",route="/health",status="200"} 1' in body
    assert 'http_server_success_total{service="scribe",route="/health"} 1' in body
