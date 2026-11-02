"""Pause gate for the background loops (liveness, monitor, scheduler).

Each loop runs one iteration inside `loop_work()`; a restore takes
`exclusive()`, which waits for any running iteration to finish and holds new
ones off until the restored data is in place — so a sweep can never write
stale rows into a freshly restored database.
"""
import threading
from contextlib import contextmanager

_cond = threading.Condition()
_active = 0          # loop iterations running right now
_paused = False


@contextmanager
def loop_work():
    global _active
    with _cond:
        while _paused:
            _cond.wait()
        _active += 1
    try:
        yield
    finally:
        with _cond:
            _active -= 1
            _cond.notify_all()


@contextmanager
def exclusive(timeout: float = 120):
    """Pause the loops for the duration. Raises TimeoutError if a running
    iteration doesn't finish within `timeout` seconds."""
    global _paused
    with _cond:
        if _paused:
            raise RuntimeError("Another restore is already running")
        _paused = True
        if not _cond.wait_for(lambda: _active == 0, timeout=timeout):
            _paused = False
            _cond.notify_all()
            raise TimeoutError("Background checks did not pause in time")
    try:
        yield
    finally:
        with _cond:
            _paused = False
            _cond.notify_all()


def is_paused() -> bool:
    return _paused
