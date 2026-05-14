#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -d venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv venv
  ./venv/bin/pip install -q --upgrade pip
  ./venv/bin/pip install -q -r requirements.txt
fi

PORT=${PORT:-12100}
echo "Starting Boltarr on http://0.0.0.0:${PORT}"
./venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port "${PORT}" --reload
