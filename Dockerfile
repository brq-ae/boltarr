FROM python:3.12-slim

# nmap is required for network scanning
RUN apt-get update \
    && apt-get install -y --no-install-recommends nmap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY VERSION .

# Runtime data (DB + config) is stored in /app/data — mount a volume here
RUN mkdir -p /app/data

ENV PORT=12100
EXPOSE 12100

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}"]
