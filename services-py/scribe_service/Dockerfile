# syntax=docker/dockerfile:1
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY pyproject.toml ./pyproject.toml
RUN pip install --no-cache-dir uvicorn fastapi pydantic

COPY common ./common
COPY scribe_service/main.py ./scribe_service/main.py

EXPOSE 8082
CMD ["uvicorn", "scribe_service.main:app", "--host", "0.0.0.0", "--port", "8082"]
