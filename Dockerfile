FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8000 \
    GATEWAY_DATA_DIR=/app/data

WORKDIR /app
COPY pyproject.toml README.md agent.py ./
COPY gateway ./gateway
COPY remote_agent ./remote_agent
RUN pip install --no-cache-dir .

VOLUME ["/app/data"]
EXPOSE 8000
CMD ["python", "-m", "gateway"]
