"""Test setup: point Boltarr at a throwaway data dir *before* importing it, and
keep the background loops (liveness, monitor, scheduler) off."""
import os
import sys
import tempfile
from pathlib import Path

import pytest

_DATA = tempfile.mkdtemp(prefix="boltarr-test-")
# An existing config.yaml means "not a fresh install", so the first-run
# password screen doesn't gate the tests (test_auth.py covers that path).
Path(_DATA, "config.yaml").write_text("{}\n")
os.environ["BOLTARR_DATA_DIR"] = _DATA
os.environ["BOLTARR_DISABLE_LOOPS"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def data_dir():
    return Path(_DATA)
