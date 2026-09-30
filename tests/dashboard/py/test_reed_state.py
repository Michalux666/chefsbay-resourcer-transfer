"""GET /status Reed indicator: follows RESOURCER_SOURCES (process env, then the profile .env files) and never says
"Auth OK" for a Reed that is off or has never logged in. Every value here is invented."""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from conftest import iso, url

SECRETS = {
    "AI_GATEWAY_API_KEY": "vck_FAKE-gateway-key-0123456789",
    "BACKUP_PASSPHRASE": "fake backup passphrase 9876",
    "ZOHO_CLIENT_SECRET": "fake-zoho-client-secret-abcdef",
    "CATERER_PASSWORD": "fake-caterer-pass-xyz789",
}
ALLOWED_KEYS = {"state", "updatedAt", "detail", "source", "ageMinutes", "enabled", "sources"}


def ago(**kw):
    return iso(datetime.now(timezone.utc) - timedelta(**kw))


def profile_env(ws):
    return ws.root.parent.parent / ".env"


def env_lines(*extra, secrets=True):
    lines = ["# resourcer profile settings (fake)"]
    if secrets:
        lines += ["%s=%s" % (k, v) for k, v in SECRETS.items()]
        lines.append('export ZOHO_REFRESH_TOKEN="fake refresh token 555"')
    return lines + list(extra)


def put_env(ws, *lines, raw=None):
    path = profile_env(ws)
    path.write_bytes(raw if raw is not None else ("\n".join(lines) + "\n").encode("utf-8"))
    return path


def status(client):
    r = client.get(url("/status"))
    assert r.status_code == 200, r.text
    return r.json()


def reed(client):
    return status(client)["reed"]


@pytest.mark.parametrize("raw", ["caterer", "CATERER", "  caterer  ", '"caterer"', "'caterer'", "", "bogus"])
def test_reed_is_disabled_when_the_setting_excludes_it(plugin, ws, client, db, raw):
    put_env(ws, *env_lines("RESOURCER_SOURCES=" + raw))
    ws.write_json("runtime/reed-auth-failed.marker", {"reason": "token refresh failed", "failedAt": ago(minutes=1)})
    r = reed(client)
    assert r["state"] == "disabled" and r["enabled"] is False and r["sources"] == "caterer"
    assert r["source"] == "RESOURCER_SOURCES" and r["updatedAt"] is None and r["ageMinutes"] is None
    assert "Auth OK" not in json.dumps(r) and set(r) <= ALLOWED_KEYS


def test_disabled_detail_names_the_setting_and_never_echoes_a_bad_value(plugin, ws, client):
    put_env(ws, "RESOURCER_SOURCES=caterer")
    assert reed(client)["detail"] == "RESOURCER_SOURCES=caterer"
    put_env(ws, "RESOURCER_SOURCES=vck_FAKE-leaked-value-77")
    r = reed(client)
    assert r["state"] == "disabled" and "vck_FAKE" not in json.dumps(r) and "caterer" in r["detail"]


def test_reed_is_disabled_by_default_when_a_readable_env_has_no_setting(plugin, ws, client, db):
    put_env(ws, *env_lines("# RESOURCER_SOURCES=both"))
    r = reed(client)
    assert r["state"] == "disabled" and r["sources"] == "caterer" and "default" in r["detail"]


@pytest.mark.parametrize("value", ["both", "reed"])
def test_enabled_reed_that_never_logged_in_is_not_auth_ok(plugin, ws, client, db, value):
    put_env(ws, *env_lines("RESOURCER_SOURCES=" + value))
    r = reed(client)
    assert r["state"] == "not_logged_in" and r["enabled"] is True and r["sources"] == value
    assert "no successful" in r["detail"] and r["updatedAt"] is None


def test_enabled_reed_without_any_history_is_not_logged_in(plugin, ws, client):
    put_env(ws, "RESOURCER_SOURCES=both")
    assert reed(client)["state"] == "not_logged_in"


def test_a_stale_disabled_status_file_does_not_hide_an_enabled_reed(plugin, ws, client, db):
    put_env(ws, "RESOURCER_SOURCES=both")
    ws.write_json("runtime/reed-status.json", {"state": "disabled", "updatedAt": ago(hours=5), "detail": "RESOURCER_SOURCES=caterer"})
    assert reed(client)["state"] == "not_logged_in"


@pytest.mark.parametrize("with_db", [False, True])
def test_enabled_reed_with_a_recorded_login_is_ok(plugin, ws, client, with_db):
    if with_db:
        ws.make_db()
        ws.seed_standard()
    put_env(ws, "RESOURCER_SOURCES=both")
    ws.write_json("runtime/reed-status.json", {"state": "ok", "updatedAt": ago(minutes=30), "detail": "login ok"})
    r = reed(client)
    assert r["state"] == "ok" and r["enabled"] is True and r["source"] == "runtime/reed-status.json" and r["ageMinutes"] in (30, 31)


def test_enabled_reed_failures_still_show_as_failures(plugin, ws, client, db):
    put_env(ws, "RESOURCER_SOURCES=both")
    ws.write_json("runtime/reed-auth-failed.marker", {"reason": "token refresh failed", "failedAt": ago(minutes=5)})
    r = reed(client)
    assert r["state"] == "auth_failed" and r["detail"] == "token refresh failed" and r["enabled"] is True
    os.unlink(ws.root / "runtime" / "reed-auth-failed.marker")
    ws.write_json("runtime/reed-status.json", {"state": "auth_failed", "updatedAt": ago(minutes=2), "detail": "human login required"})
    assert reed(client)["state"] == "auth_failed"


def test_missing_env_falls_back_to_the_status_file_then_history(plugin, ws, client):
    assert plugin.reed_source_setting() is None
    assert reed(client)["state"] == "unknown"
    ws.write_json("runtime/reed-status.json", {"state": "disabled", "updatedAt": ago(minutes=1), "detail": "RESOURCER_SOURCES=caterer"})
    r = reed(client)
    assert r["state"] == "disabled" and r["source"] == "runtime/reed-status.json" and r["enabled"] is None and r["sources"] is None
    os.unlink(ws.root / "runtime" / "reed-status.json")
    ws.make_db()
    ws.seed_standard()
    plugin._CACHE.clear()
    r = reed(client)
    assert r["state"] == "ok" and r["source"] == "run_results"


@pytest.mark.parametrize("raw", [
    b"RESOURCER_SOURCES=both\n\x00\x00\x00binary",
    b"\xff\xfe RESOURCER_SOURCES=both \x80\x81",
    (b"# padding\n" * 20000) + b"RESOURCER_SOURCES=both\n",
], ids=["nul-bytes", "invalid-utf8", "over-size"])
def test_unreadable_or_malformed_env_falls_back(plugin, ws, client, raw):
    put_env(ws, raw=raw)
    assert plugin.reed_source_setting() is None
    assert reed(client)["state"] == "unknown"
    ws.write_json("runtime/reed-status.json", {"state": "disabled", "updatedAt": ago(minutes=1), "detail": "x"})
    r = reed(client)
    assert r["state"] == "disabled" and r["source"] == "runtime/reed-status.json"


def test_an_env_that_is_a_directory_does_not_break_status(plugin, ws, client):
    profile_env(ws).mkdir()
    assert plugin.reed_source_setting() is None
    assert reed(client)["state"] == "unknown"


def test_an_env_that_is_a_fifo_is_never_opened(plugin, ws):
    if not hasattr(os, "mkfifo"):
        pytest.skip("no mkfifo")
    os.mkfifo(profile_env(ws))
    assert plugin.reed_source_setting() is None


def test_plain_text_junk_without_the_setting_counts_as_no_setting(plugin, ws, client):
    put_env(ws, "this is not a settings file", "=== ??? ===", "RESOURCER_SOURCES", "1=2")
    r = reed(client)
    assert r["state"] == "disabled" and r["sources"] == "caterer"


def test_process_environment_wins_over_the_files(plugin, ws, client, monkeypatch):
    put_env(ws, "RESOURCER_SOURCES=caterer")
    monkeypatch.setenv("RESOURCER_SOURCES", "both")
    r = reed(client)
    assert r["state"] == "not_logged_in" and r["sources"] == "both"
    put_env(ws, "RESOURCER_SOURCES=both")
    monkeypatch.setenv("RESOURCER_SOURCES", "caterer")
    assert reed(client)["state"] == "disabled"
    monkeypatch.setenv("RESOURCER_SOURCES", "")
    assert reed(client)["state"] == "not_logged_in"


def test_process_environment_alone_is_enough(plugin, ws, client, monkeypatch):
    monkeypatch.setenv("RESOURCER_SOURCES", "reed")
    r = reed(client)
    assert r["state"] == "not_logged_in" and r["sources"] == "reed"


def test_file_precedence_matches_the_pipeline(plugin, ws, client, monkeypatch):
    home_env = ws.root / ".env"
    override = ws.root.parent.parent / "override.env"
    home_env.write_text("RESOURCER_SOURCES=both\n")
    assert reed(client)["state"] == "not_logged_in"
    put_env(ws, "RESOURCER_SOURCES=caterer")
    assert reed(client)["state"] == "disabled"
    override.write_text("RESOURCER_SOURCES=reed\n")
    monkeypatch.setenv("RESOURCER_ENV_FILE", str(override))
    assert reed(client)["sources"] == "reed"
    override.write_text("RESOURCER_SOURCES=\n")
    assert reed(client)["sources"] == "caterer", "the first file that defines the key wins, even empty (env.js)"


def test_lines_are_parsed_like_the_pipeline_parser(plugin, ws, client):
    put_env(ws, "#RESOURCER_SOURCES=both", "RESOURCER_SOURCES_EXTRA=both", "XRESOURCER_SOURCES=both", "RESOURCER_SOURCES=reed",
            "export RESOURCER_SOURCES = both", "RESOURCER_SOURCES=caterer # not a comment, so invalid")
    assert reed(client)["sources"] == "caterer"
    put_env(ws, "RESOURCER_SOURCES=caterer", "export RESOURCER_SOURCES = both")
    assert reed(client)["sources"] == "both"
    put_env(ws, raw=b"A=1\r\nRESOURCER_SOURCES=reed\r\n")
    assert reed(client)["sources"] == "reed"
    put_env(ws, raw=b"\xef\xbb\xbfRESOURCER_SOURCES=both\n")
    assert reed(client)["sources"] == "both"


def test_env_outside_the_profile_is_never_read(plugin, ws, client, tmp_path, monkeypatch):
    outside = tmp_path / "elsewhere.env"
    outside.write_text("RESOURCER_SOURCES=both\n")
    monkeypatch.setenv("RESOURCER_ENV_FILE", str(outside))
    assert plugin.reed_source_setting() is None
    monkeypatch.delenv("RESOURCER_ENV_FILE")
    try:
        os.symlink(outside, profile_env(ws))
    except OSError:
        pytest.skip("symlinks unavailable")
    assert plugin.reed_source_setting() is None
    assert reed(client)["state"] == "unknown"


def test_a_workspace_that_is_not_under_a_profile_reads_no_parent_env(plugin, tmp_path, monkeypatch):
    home = tmp_path / "some" / "place" / "resourcer"
    home.mkdir(parents=True)
    (tmp_path / "some" / ".env").write_text("RESOURCER_SOURCES=both\n")
    (home.parent / ".env").write_text("RESOURCER_SOURCES=both\n")
    monkeypatch.setenv("RESOURCER_HOME", str(home))
    monkeypatch.delenv("RESOURCER_SOURCES", raising=False)
    monkeypatch.delenv("RESOURCER_ENV_FILE", raising=False)
    assert plugin.reed_source_setting() is None


def test_a_machine_level_parent_env_is_never_read(plugin, tmp_path, monkeypatch):
    machine = tmp_path / "opt-data"
    home = machine / "workspace" / "resourcer"
    home.mkdir(parents=True)
    (machine / "profiles").mkdir()
    (machine / ".env").write_text("RESOURCER_SOURCES=both\n")
    monkeypatch.setenv("RESOURCER_HOME", str(home))
    monkeypatch.delenv("RESOURCER_SOURCES", raising=False)
    monkeypatch.delenv("RESOURCER_ENV_FILE", raising=False)
    assert plugin.reed_source_setting() is None


def test_no_secret_or_other_env_value_appears_in_any_response(plugin, ws, client, db):
    leak = "vck_FAKE-leaked-value-77"
    for setting in ("both", "caterer", leak):
        put_env(ws, *env_lines("RESOURCER_SOURCES=" + setting))
        ws.write_text("runtime/reed-status.json", json.dumps({"state": "ok", "updatedAt": ago(minutes=1), "detail": "fine"}))
        blob = ""
        for route in ("/health", "/status", "/stats", "/runs", "/territories", "/schedule", "/halt", "/errors"):
            blob += client.get(url(route)).text
        for key, value in list(SECRETS.items()) + [("ZOHO_REFRESH_TOKEN", "fake refresh token 555")]:
            assert key not in blob and value not in blob, key
        assert leak not in blob and "# resourcer profile settings" not in blob
        assert set(reed(client)) <= ALLOWED_KEYS


def test_setting_reader_returns_only_the_normalised_value(plugin, ws):
    put_env(ws, *env_lines("RESOURCER_SOURCES=  Both  "))
    got = plugin.reed_source_setting()
    assert got == {"value": "both", "valid": True, "origin": "file"}
    put_env(ws, *env_lines("RESOURCER_SOURCES=nonsense"))
    assert plugin.reed_source_setting() == {"value": "caterer", "valid": False, "origin": "file"}
    put_env(ws, *env_lines())
    assert plugin.reed_source_setting() == {"value": "caterer", "valid": True, "origin": "default"}
