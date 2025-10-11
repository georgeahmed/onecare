# syntax=docker/dockerfile:1
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY pyproject.toml ./pyproject.toml
RUN pip install --no-cache-dir uvicorn fastapi pydantic

COPY common ./common
COPY scribe_service/main.py ./scribe_service/main.py

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import json, sys, urllib.request; data = json.load(urllib.request.urlopen('http://127.0.0.1:8082/ready', timeout=2)); sys.exit(0 if data.get('status') == 'ready' else 1)"]

CMD ["uvicorn", "scribe_service.main:app", "--host", "0.0.0.0", "--port", "8082"]
