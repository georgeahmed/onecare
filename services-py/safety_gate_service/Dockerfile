# syntax=docker/dockerfile:1
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# Resource guidance: baseline 0.5 CPU / 512Mi memory. See docs/RUNBOOKS.md#python-ml-services.
RUN adduser --system --group appuser

COPY --chown=appuser:appuser pyproject.toml ./pyproject.toml
RUN pip install --no-cache-dir uvicorn fastapi "pydantic>=2.0"

COPY --chown=appuser:appuser common ./common
COPY --chown=appuser:appuser safety_gate_service ./safety_gate_service

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import json, sys, urllib.request; data = json.load(urllib.request.urlopen('http://127.0.0.1:8081/ready', timeout=2)); sys.exit(0 if data.get('status') == 'ready' else 1)"]

USER appuser

CMD ["uvicorn", "safety_gate_service.main:app", "--host", "0.0.0.0", "--port", "8081"]
