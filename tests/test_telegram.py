"""S-24: Telegram alerts. The same alerts as ntfy go to a Telegram chat; an alert
counts as sent when either channel got it. The bot token never shows up in an
error, a log line or Settings. All Telegram calls are faked: no network."""
import httpx
import pytest

from backend import config, main, notify

DEMO_TOKEN = "123456789:AAdemoDEMOdemoDEMOdemoDEMOdemoDEMO1"


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(notify, "_fail_mono", 0.0)
    monkeypatch.setattr(notify, "_tg_fail_mono", 0.0)
    yield
    cfg = config.get_config()
    cfg["telegram"] = {"enabled": False, "token": "", "chat_id": ""}
    config.save_config(cfg)


def _channels(monkeypatch, ntfy=None, tg=None):
    """Switch channels on for notify.send(); None = off, else the result to fake."""
    monkeypatch.setattr(notify, "get_notifications_config",
                        lambda: {"enabled": ntfy is not None, "server": "http://ntfy.demo", "topic": "demo-topic"})
    monkeypatch.setattr(notify, "get_telegram_config",
                        lambda: {"enabled": tg is not None, "token": DEMO_TOKEN, "chat_id": "42"})
    sent = []
    monkeypatch.setattr(notify, "_post_ntfy", lambda *a: (sent.append("ntfy"), ntfy)[1])
    monkeypatch.setattr(notify, "_post_telegram", lambda *a: (sent.append("telegram"), tg)[1])
    return sent


def test_an_alert_goes_to_both_and_counts_if_either_got_it(monkeypatch):
    sent = _channels(monkeypatch, ntfy=(False, "demo: refused"), tg=(True, ""))
    assert notify.send("Demo is down", "x") == (True, "")
    assert sent == ["ntfy", "telegram"]
    assert notify.health("telegram")["last_ok"] and "refused" in notify.health()["last_error"]


def test_both_failing_is_a_failure(monkeypatch):
    _channels(monkeypatch, ntfy=(False, "a"), tg=(False, "b"))
    ok, err = notify.send("t", "m")
    assert not ok and "ntfy: a" in err and "Telegram: b" in err


def test_telegram_alone_is_enough(monkeypatch):
    sent = _channels(monkeypatch, tg=(True, ""))
    assert notify.is_on() and notify.deliver("t", "m") == "sent" and sent == ["telegram"]


def test_nothing_on_means_off(monkeypatch):
    _channels(monkeypatch)
    assert not notify.is_on() and notify.deliver("t", "m") == "off"


def test_a_failed_channel_is_skipped_for_a_while_the_other_still_sends(monkeypatch):
    sent = _channels(monkeypatch, ntfy=(True, ""), tg=(False, "demo: down"))
    assert notify.deliver("t", "m") == "sent"
    assert notify.deliver("t", "m") == "sent"
    assert sent == ["ntfy", "telegram", "ntfy"]              # Telegram waits out its back-off


def test_every_channel_waiting_fails_at_once(monkeypatch):
    sent = _channels(monkeypatch, ntfy=(False, "x"), tg=(False, "y"))
    assert notify.deliver("t", "m") == "failed" and notify.deliver("t", "m") == "failed"
    assert sent == ["ntfy", "telegram"]


def test_message_text_is_escaped_with_the_alert_emoji():
    t = notify._tg_text("Web <admin> is down", "a & b", ["rotating_light"])
    assert t == "🚨 <b>Web &lt;admin&gt; is down</b>\na &amp; b"
    long = notify._tg_text("T", "x" * 9000, None)
    assert len(long) <= notify._TG_MAX and long.endswith("…")


def test_low_priority_is_silent(monkeypatch):
    calls = []
    monkeypatch.setattr(notify, "_tg_call", lambda tok, method, payload: (calls.append(payload), (True, {}))[1])
    notify._post_telegram({"token": DEMO_TOKEN, "chat_id": "42"}, "t", "m", "low", None)
    notify._post_telegram({"token": DEMO_TOKEN, "chat_id": "42"}, "t", "m", "high", None)
    assert [c["disable_notification"] for c in calls] == [True, False]


class _Boom:
    """An httpx.Client whose request fails with the full address in the message,
    as a real connection error does."""
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def post(self, url, **k):
        raise httpx.ConnectError(f"demo: connection refused for url '{url}'")


def test_the_token_never_appears_in_errors_or_health(monkeypatch, capsys):
    monkeypatch.setattr(notify.httpx, "Client", _Boom)
    ok, err = notify.telegram_send_with({"token": DEMO_TOKEN, "chat_id": "42"}, "t", "m")
    assert not ok and "connection refused" in err
    secret = DEMO_TOKEN.split(":")[1]
    assert secret not in err and secret not in str(notify.health("telegram"))
    monkeypatch.setattr(notify, "get_notifications_config", lambda: {"enabled": False})
    monkeypatch.setattr(notify, "get_telegram_config", lambda: {"enabled": True, "token": DEMO_TOKEN, "chat_id": "42"})
    notify.send("t", "m")
    assert secret not in capsys.readouterr().out               # the log line is clean too


class _Reply:
    def __init__(self, status, body): self.status_code, self._body = status, body
    def json(self): return self._body


def _fake_telegram(monkeypatch, status, body):
    class C(_Boom):
        def post(self, url, **k): return _Reply(status, body)
    monkeypatch.setattr(notify.httpx, "Client", C)


def test_telegram_errors_are_explained(monkeypatch):
    _fake_telegram(monkeypatch, 401, {"ok": False, "description": "Unauthorized"})
    assert "bot token" in notify.telegram_send_with({"token": DEMO_TOKEN, "chat_id": "42"}, "t", "m")[1]
    _fake_telegram(monkeypatch, 400, {"ok": False, "description": "Bad Request: chat not found"})
    assert "Chat not found" in notify.telegram_send_with({"token": DEMO_TOKEN, "chat_id": "42"}, "t", "m")[1]


def test_find_my_chat_id_takes_the_newest_chat(monkeypatch):
    _fake_telegram(monkeypatch, 200, {"ok": True, "result": [
        {"update_id": 1, "message": {"chat": {"id": 111, "type": "private", "first_name": "Old"}}},
        {"update_id": 2, "message": {"chat": {"id": 222, "type": "private", "first_name": "Demo", "last_name": "User"}}},
    ]})
    ok, res = notify.telegram_find_chat(DEMO_TOKEN)
    assert ok and res == {"chat_id": "222", "name": "Demo User", "type": "private"}
    _fake_telegram(monkeypatch, 200, {"ok": True, "result": []})
    ok, res = notify.telegram_find_chat(DEMO_TOKEN)
    assert not ok and "Send any message to your bot" in res


def test_find_my_chat_id_finds_a_group_the_bot_was_added_to(monkeypatch):
    # In a group the bot doesn't see ordinary messages, but being added is enough
    _fake_telegram(monkeypatch, 200, {"ok": True, "result": [
        {"update_id": 3, "my_chat_member": {"chat": {"id": -1001234567890, "type": "supergroup", "title": "Demo Home"}}},
    ]})
    ok, res = notify.telegram_find_chat(DEMO_TOKEN)
    assert ok and res == {"chat_id": "-1001234567890", "name": "Demo Home", "type": "supergroup"}


# ── Settings ──────────────────────────────────────────────────────────────────

def _save(client, **tg):
    return client.put("/api/settings/all", json={"telegram": tg})


def test_settings_hide_the_token_and_keep_it(client):
    r = _save(client, enabled=True, token=DEMO_TOKEN, chat_id="42")
    assert r.status_code == 200 and r.json()["telegram"] == {"enabled": True, "token": main._MASKED, "chat_id": "42"}
    assert DEMO_TOKEN not in client.get("/api/settings").text
    _save(client, enabled=True, token=main._MASKED, chat_id="-1001234567890")   # masked = keep the saved one
    assert config.get_telegram_config() == {"enabled": True, "token": DEMO_TOKEN, "chat_id": "-1001234567890"}


def test_settings_refuse_bad_values(client):
    assert _save(client, token="not-a-token").status_code == 422
    assert _save(client, token=DEMO_TOKEN, chat_id="my chat").status_code == 422
    assert _save(client, enabled=True, token=DEMO_TOKEN, chat_id="").status_code == 422   # can't switch on half set up
    assert config.get_telegram_config()["token"] == ""                                    # nothing was saved


def test_test_and_find_use_the_saved_token(client, monkeypatch):
    _save(client, token=DEMO_TOKEN, chat_id="42")
    used = []
    monkeypatch.setattr(notify, "_tg_call", lambda tok, method, payload: (used.append((tok, method)), (True, []))[1])
    assert client.post("/api/notifications/telegram/test", json={"token": main._MASKED, "chat_id": "42"}).json()["ok"]
    r = client.post("/api/notifications/telegram/find-chat", json={"token": main._MASKED}).json()
    assert not r["ok"] and DEMO_TOKEN not in str(r)
    assert used == [(DEMO_TOKEN, "sendMessage"), (DEMO_TOKEN, "getUpdates")]


def test_health_reports_telegram(client):
    assert "telegram" in client.get("/api/monitor/health").json()
