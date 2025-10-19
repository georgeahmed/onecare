# syntax=docker/dockerfile:1
FROM python:3.11-slim AS builder
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN pip install --upgrade pip
RUN pip install --no-cache-dir --target /opt/python uvicorn fastapi "pydantic>=1.10,<2"
COPY services-py/common ./common
COPY services-py/scribe_service ./scribe_service

FROM gcr.io/distroless/python3-debian12
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/opt/python
WORKDIR /app
COPY --from=builder --chown=65532:65532 /opt/python /opt/python
COPY --from=builder --chown=65532:65532 /app /app
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/usr/bin/python3", "-c", "import json, sys, urllib.request; data = json.load(urllib.request.urlopen('http://127.0.0.1:8082/ready', timeout=2)); sys.exit(0 if data.get('status') == 'ready' else 1)"]
USER 65532
CMD ["-m", "uvicorn", "scribe_service.main:app", "--host", "0.0.0.0", "--port", "8082"]
