"""v0.27.0 Part 3 (data): F-38 local time, F-23 daylight-saving schedules,
F-34 scan errors/overlap/time limit, F-24 ports per address, F-42 leftovers."""
from datetime import datetime, timedelta, timezone

import pytest

from backend import config, monitor
from backend.database import get_conn


@pytest.fixture
def tz(monkeypatch):
    """Set Boltarr's timezone (Settings → General) for one test."""
    def set_tz(name):
        cfg = config.get_config()
        cfg.setdefault("general", {})["timezone"] = name
        config.save_config(cfg)
    yield set_tz
    set_tz("")


def _iso(d):
    return d.astimezone(timezone.utc).isoformat(timespec="seconds")


# ── F-38: status page bar labels in Boltarr's timezone ──────────────────────────

def test_bar_labels_use_the_configured_timezone(tz):
    ts = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc).timestamp()
    tz("America/New_York")                                   # UTC-5 in November
    assert monitor._hr_label(ts) == "Nov 14 07:00"
    assert monitor._min_label(ts) == "Nov 14 07:00"
    assert monitor._day_label(datetime(2026, 11, 14, 3, 0, tzinfo=timezone.utc).timestamp()) == "Nov 13"
    tz("Asia/Tokyo")                                         # UTC+9
    assert monitor._hr_label(ts) == "Nov 14 21:00"


def test_status_page_bars_carry_local_labels(client, tz, monkeypatch):
    monkeypatch.setattr(monitor, "push_status", lambda: (True, ""))
    tz("America/New_York")
    with get_conn() as conn:
        conn.execute("INSERT INTO hosts (ip, hostname) VALUES ('10.38.0.1', 'demo-tz')")
        hid = conn.execute("SELECT id FROM hosts WHERE ip='10.38.0.1'").fetchone()[0]
        conn.execute("INSERT INTO services (host_id, name, monitored, public, monitor_status) "
                     "VALUES (?, 'Demo tz', 1, 1, 'up')", (hid,))
        sid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
    now = datetime(2026, 11, 14, 12, 30, tzinfo=timezone.utc)
    bars = monitor.tick_windows("monitor_events", "service_id", sid, now=now)
    assert bars["24h"][-1]["date"] == "Nov 14 07:00"                 # last hour's middle, 12:00 UTC = 07:00 New York
    assert bars["7d"][-1]["date"] == "Nov 13"                        # last day's middle, 14 Nov 00:30 UTC = 13 Nov 19:30 local


# ── F-23: fixed-time schedules on the local wall clock, also on clock-change days ──

from zoneinfo import ZoneInfo                                     # noqa: E402

from backend import scheduler                                     # noqa: E402

# 2026 changes: Berlin 29 Mar 02:00→03:00 and 25 Oct 03:00→02:00;
# New York 8 Mar 02:00→03:00 and 1 Nov 02:00→01:00.
_CHANGES = {"Europe/Berlin": [(2026, 3, 29), (2026, 10, 25)],
            "America/New_York": [(2026, 3, 8), (2026, 11, 1)]}


def _simulate(sched, zone, day, monkeypatch, days_before=3, days_after=4):
    """Tick once a minute (like the scheduler loop) from a few days before a
    clock change to a few days after; returns the local times it fired."""
    z = ZoneInfo(zone)
    monkeypatch.setattr(scheduler, "get_timezone", lambda: z)
    start = datetime(*day, tzinfo=z) - timedelta(days=days_before)
    # as if it last ran just before the start (else the first tick is a catch-up run)
    sched = dict(sched, enabled=1, created_at="2026-01-01 00:00:00",
                 last_run=(start - timedelta(minutes=1)).astimezone(timezone.utc).isoformat(timespec="seconds"))
    t, end = start.astimezone(timezone.utc), (start + timedelta(days=days_before + days_after)).astimezone(timezone.utc)
    fires, checks = [], []
    while t < end:
        if t.minute == 7 and t.hour % 5 == 0:                 # now and then: does the preview agree?
            checks.append((t, scheduler.next_run_utc(sched, t)))
        if scheduler.is_due(sched, t):
            fires.append(t)
            sched["last_run"] = t.isoformat(timespec="seconds")
        t += timedelta(minutes=1)
    for at, nxt in checks:                                   # "Next run" = the minute it really fires
        real = next((f for f in fires if f > at), None)
        if real and nxt:
            assert abs((datetime.fromisoformat(nxt) - real).total_seconds()) < 60, (zone, at, nxt, real)
    return [f.astimezone(z) for f in fires]


def _per_day(fires):
    out = {}
    for f in fires:
        out.setdefault(f.date(), []).append(f.strftime("%H:%M"))
    return out


@pytest.mark.parametrize("zone", list(_CHANGES))
@pytest.mark.parametrize("which", [0, 1])                     # spring forward, autumn back
def test_daily_0300_runs_once_a_day_at_0300(zone, which, monkeypatch):
    fires = _simulate({"timing_type": "interval", "interval_hours": 24, "at_time": "03:00"},
                      zone, _CHANGES[zone][which], monkeypatch)
    per_day = _per_day(fires)
    assert len(per_day) == 7 and all(v == ["03:00"] for v in per_day.values()), per_day


@pytest.mark.parametrize("zone", list(_CHANGES))
def test_a_time_the_clocks_skip_runs_once_just_after(zone, monkeypatch):
    """02:30 doesn't exist on spring-forward day: it runs once, at 03:00."""
    day = _CHANGES[zone][0]
    fires = _simulate({"timing_type": "interval", "interval_hours": 24, "at_time": "02:30"}, zone, day, monkeypatch)
    per_day = _per_day(fires)
    assert len(per_day) == 7 and all(len(v) == 1 for v in per_day.values()), per_day
    from datetime import date
    assert per_day[date(*day)] == ["03:00"]
    assert all(v == ["02:30"] for d, v in per_day.items() if d != date(*day))


@pytest.mark.parametrize("zone", list(_CHANGES))
def test_a_time_that_happens_twice_runs_once(zone, monkeypatch):
    """01:30 happens twice on autumn day (New York) / 02:30 (Berlin): one run."""
    at = "01:30" if zone == "America/New_York" else "02:30"
    fires = _simulate({"timing_type": "interval", "interval_hours": 24, "at_time": at},
                      zone, _CHANGES[zone][1], monkeypatch)
    per_day = _per_day(fires)
    assert len(per_day) == 7 and all(v == [at] for v in per_day.values()), per_day


@pytest.mark.parametrize("zone", list(_CHANGES))
@pytest.mark.parametrize("which", [0, 1])
def test_every_6_hours_from_midnight_keeps_its_clock_times(zone, which, monkeypatch):
    fires = _simulate({"timing_type": "interval", "interval_hours": 6, "at_time": "00:00"},
                      zone, _CHANGES[zone][which], monkeypatch)
    for d, times in _per_day(fires).items():
        assert times == ["00:00", "06:00", "12:00", "18:00"], (d, times)


@pytest.mark.parametrize("zone", list(_CHANGES))
@pytest.mark.parametrize("which", [0, 1])
def test_weekly_runs_once_on_each_chosen_day(zone, which, monkeypatch):
    fires = _simulate({"timing_type": "weekly", "days_of_week": "0,1,2,3,4,5,6", "at_time": "03:00"},
                      zone, _CHANGES[zone][which], monkeypatch)
    per_day = _per_day(fires)
    assert len(per_day) == 7 and all(v == ["03:00"] for v in per_day.values()), per_day


@pytest.mark.parametrize("zone", list(_CHANGES))
def test_weekly_on_change_day_at_a_skipped_time(zone, monkeypatch):
    day = _CHANGES[zone][0]                                   # both are Sundays (weekday 6)
    fires = _simulate({"timing_type": "weekly", "days_of_week": "6", "at_time": "02:30"}, zone, day, monkeypatch)
    assert [f.strftime("%a %H:%M") for f in fires] == ["Sun 03:00"]


@pytest.mark.parametrize("zone", list(_CHANGES))
@pytest.mark.parametrize("which", [0, 1])
def test_plain_interval_counts_real_hours(zone, which, monkeypatch):
    """Without a start time, 'every 8 hours' is real elapsed time, which a clock
    change doesn't disturb (no double or missing run)."""
    fires = _simulate({"timing_type": "interval", "interval_hours": 8, "at_time": None},
                      zone, _CHANGES[zone][which], monkeypatch)
    utc = [f.astimezone(timezone.utc) for f in fires]           # same-zone subtraction would use the wall clock
    gaps = {(b - a).total_seconds() / 3600 for a, b in zip(utc, utc[1:])}
    assert gaps == {8.0} and len(fires) >= 20


def test_window_still_applies_on_change_days(monkeypatch):
    fires = _simulate({"timing_type": "interval", "interval_hours": 1, "at_time": "00:00",
                       "window_start": "01:00", "window_end": "04:00"},
                      "Europe/Berlin", _CHANGES["Europe/Berlin"][1], monkeypatch)
    assert fires and all(1 <= f.hour <= 4 for f in fires)
    assert max(len(v) for v in _per_day(fires).values()) <= 4


# ── F-42: a run missed while Boltarr was off isn't caught up outside the window ──

def _berlin(monkeypatch):
    z = ZoneInfo("Europe/Berlin")
    monkeypatch.setattr(scheduler, "get_timezone", lambda: z)
    return z


def test_catch_up_inside_the_window_still_runs(monkeypatch):
    z = _berlin(monkeypatch)
    s = {"enabled": 1, "timing_type": "interval", "interval_hours": 24, "at_time": "02:00",
         "window_start": "01:00", "window_end": "05:00", "created_at": "2026-01-01 00:00:00",
         "last_run": "2026-06-09T00:00:00+00:00"}
    assert scheduler.is_due(s, datetime(2026, 6, 10, 4, 30, tzinfo=z).astimezone(timezone.utc))


def test_catch_up_outside_the_window_waits_for_the_next_slot(monkeypatch):
    z = _berlin(monkeypatch)
    s = {"enabled": 1, "timing_type": "interval", "interval_hours": 24, "at_time": "02:00",
         "window_start": "01:00", "window_end": "05:00", "created_at": "2026-01-01 00:00:00",
         "last_run": "2026-06-09T00:00:00+00:00"}
    assert not scheduler.is_due(s, datetime(2026, 6, 10, 11, 0, tzinfo=z).astimezone(timezone.utc))
    w = dict(s, timing_type="weekly", days_of_week="2")      # Wednesday 10 June
    assert not scheduler.is_due(w, datetime(2026, 6, 10, 11, 0, tzinfo=z).astimezone(timezone.utc))
    assert scheduler.is_due(w, datetime(2026, 6, 10, 2, 3, tzinfo=z).astimezone(timezone.utc))


def test_slot_at_the_window_end_still_fires_a_minute_late(monkeypatch):
    z = _berlin(monkeypatch)
    s = {"enabled": 1, "timing_type": "weekly", "days_of_week": "2", "at_time": "05:00",
         "window_start": "01:00", "window_end": "05:00", "created_at": "2026-01-01 00:00:00", "last_run": None}
    assert scheduler.is_due(s, datetime(2026, 6, 10, 5, 1, 30, tzinfo=z).astimezone(timezone.utc))


def test_no_window_catches_up_as_before(monkeypatch):
    z = _berlin(monkeypatch)
    s = {"enabled": 1, "timing_type": "interval", "interval_hours": 24, "at_time": "02:00",
         "created_at": "2026-01-01 00:00:00", "last_run": "2026-06-09T00:00:00+00:00"}
    assert scheduler.is_due(s, datetime(2026, 6, 10, 15, 0, tzinfo=z).astimezone(timezone.utc))
