"""Loader contract, static rules, time helpers, scrubbing and settings parsing."""
import ast
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from conftest import API_FILE, PREFIX, REPO, build_app, load_plugin_module

MANIFEST = REPO / "plugin" / "resourcer" / "dashboard" / "manifest.json"
ALLOWED_IMPORTS = {"__future__", "errno", "json", "math", "os", "re", "secrets", "shutil", "sqlite3", "sys", "threading", "time", "urllib",
                   "datetime", "pathlib", "typing", "fastapi", "zoneinfo"}
EXPECTED_ROUTES = {
    ("GET", "/health"), ("GET", "/halt"), ("GET", "/status"), ("GET", "/stats"), ("GET", "/runs"), ("GET", "/territories"),
    ("GET", "/schedule"), ("POST", "/search"), ("POST", "/halt/clear"), ("GET", "/errors"), ("POST", "/errors/ack"),
}


def test_module_exports_router_and_matches_the_manifest(plugin):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["name"] == plugin.PLUGIN_NAME == "resourcer"
    assert manifest["api"] == "plugin_api.py" and manifest["entry"] == "dist/index.js" and manifest["css"] == "dist/style.css"
    assert (MANIFEST.parent / manifest["api"]).is_file() and (MANIFEST.parent / manifest["entry"]).is_file() and (MANIFEST.parent / manifest["css"]).is_file()
    assert manifest["tab"]["path"].startswith("/") and manifest["version"] == plugin.PLUGIN_VERSION
    assert hasattr(plugin, "router")


def test_route_table_is_exactly_the_documented_one(plugin):
    seen = set()
    for path, ops in build_app(plugin).openapi()["paths"].items():
        assert path.startswith(PREFIX + "/"), path
        for method in ops:
            seen.add((method.upper(), path[len(PREFIX):]))
    assert seen == EXPECTED_ROUTES


def test_get_routes_are_read_only_verbs(plugin):
    for route in plugin.router.routes:
        if route.path in ("/search", "/halt/clear", "/errors/ack"):
            assert route.methods == {"POST"}
        else:
            assert route.methods == {"GET"}


def test_source_imports_only_stdlib_and_fastapi():
    tree = ast.parse(API_FILE.read_text(encoding="utf-8"))
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "relative imports do not work under the Hermes loader"
            found.add((node.module or "").split(".")[0])
    assert found <= ALLOWED_IMPORTS, found - ALLOWED_IMPORTS
    assert "yaml" not in found


def test_source_never_exits_or_prints_or_shells_out():
    src = API_FILE.read_text(encoding="utf-8")
    assert not re.search(r"\bsys\.exit\(|\bexit\(|\bquit\(|\bos\._exit\(", src)
    assert not re.search(r"\bsubprocess\b|\bos\.system\b|\bos\.popen\b|\beval\(|\bexec\(", src)
    assert not re.search(r"^\s*print\(", src, re.M)


def test_source_is_ascii_lf_and_has_no_banned_tokens():
    raw = API_FILE.read_bytes()
    assert b"\r" not in raw
    raw.decode("ascii")
    text = raw.decode("ascii")
    assert (chr(92) * 2) not in text
    banned = ["C:" + chr(92), "C:/Users", "ws" + "l ", "power" + "shell", "pw" + "sh", "open" + "claw", "pm" + "2", "sch" + "tasks", "187" + "89", "WHATS" + "APP", "ng" + "rok"]
    for token in banned:
        assert token not in text, token


def test_import_has_no_side_effects(tmp_path, monkeypatch):
    home = tmp_path / "never-created"
    monkeypatch.setenv("RESOURCER_HOME", str(home))
    before = sorted(p.name for p in tmp_path.iterdir())
    mod = load_plugin_module()
    try:
        assert sorted(p.name for p in tmp_path.iterdir()) == before and not home.exists()
    finally:
        sys.modules.pop("hermes_dashboard_plugin_resourcer", None)
    assert mod.router is not None


def test_no_plugin_config_file_ships_with_the_plugin(tmp_path, monkeypatch):
    cfg = API_FILE.with_name("plugin_config.json")
    assert not cfg.exists()
    mod = load_plugin_module()
    try:
        assert mod._config_home() is None
    finally:
        sys.modules.pop("hermes_dashboard_plugin_resourcer", None)


# --------------------------------------------------------------- time


def test_uk_offset_matches_zoneinfo(plugin):
    zoneinfo = pytest.importorskip("zoneinfo")
    try:
        london = zoneinfo.ZoneInfo("Europe/London")
    except Exception:
        pytest.skip("no tz database")
    checked = 0
    for year in range(2020, 2032):
        for month in (3, 10):
            last = plugin._last_sunday(year, month)
            base = datetime(last.year, last.month, last.day, 0, 0, tzinfo=timezone.utc)
            for minutes in range(-180, 300, 30):
                dt = base + timedelta(minutes=minutes)
                assert plugin.uk_offset_hours(dt) == int(dt.astimezone(london).utcoffset().total_seconds() // 3600), dt
                checked += 1
    step = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for i in range(0, 365 * 24, 7):
        dt = step + timedelta(hours=i)
        assert plugin.uk_offset_hours(dt) == int(dt.astimezone(london).utcoffset().total_seconds() // 3600), dt
    assert checked > 200


def test_last_sunday_helper(plugin):
    assert plugin._last_sunday(2026, 3).isoformat() == "2026-03-29"
    assert plugin._last_sunday(2026, 10).isoformat() == "2026-10-25"
    assert plugin._last_sunday(2025, 12).weekday() == 6


@pytest.mark.parametrize("utc, inside", [
    ("2026-01-15T05:59:00+00:00", False), ("2026-01-15T06:00:00+00:00", True), ("2026-01-15T21:59:00+00:00", True), ("2026-01-15T22:00:00+00:00", False),
    ("2026-07-15T04:59:00+00:00", False), ("2026-07-15T05:00:00+00:00", True), ("2026-07-15T20:59:00+00:00", True), ("2026-07-15T21:00:00+00:00", False),
])
def test_operating_hours_follow_london_time(plugin, utc, inside):
    assert plugin.in_operating_hours(plugin.DEFAULT_SETTINGS, datetime.fromisoformat(utc)) is inside


def test_operating_hours_fall_back_without_tzdata(plugin, monkeypatch):
    import zoneinfo

    def broken(name):
        raise zoneinfo.ZoneInfoNotFoundError(name)

    monkeypatch.setattr(zoneinfo, "ZoneInfo", broken)
    assert plugin.in_operating_hours(plugin.DEFAULT_SETTINGS, datetime.fromisoformat("2026-07-15T05:00:00+00:00")) is True
    assert plugin.in_operating_hours(plugin.DEFAULT_SETTINGS, datetime.fromisoformat("2026-07-15T04:59:00+00:00")) is False
    assert plugin.in_operating_hours(plugin.DEFAULT_SETTINGS, datetime.fromisoformat("2026-01-15T05:59:00+00:00")) is False
    other = json.loads(json.dumps(plugin.DEFAULT_SETTINGS))
    other["operating_hours"]["tz"] = "Mars/Olympus"
    assert plugin.in_operating_hours(other, datetime.fromisoformat("2026-07-15T06:00:00+00:00")) is True


def test_time_parsing_and_formatting(plugin):
    assert plugin.parse_iso("2026-09-29T10:00:00Z") == datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)
    assert plugin.parse_iso("2026-09-29T10:00:00.123+01:00") == datetime(2026, 9, 29, 9, 0, 0, 123000, tzinfo=timezone.utc)
    assert plugin.parse_iso("2026-09-29 10:00:00") == datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)
    assert plugin.parse_iso("2026-09-29") == datetime(2026, 9, 29, 0, 0, tzinfo=timezone.utc)
    for bad in (None, "", "  ", "yesterday", 123, {"a": 1}):
        assert plugin.parse_iso(bad) is None
    assert plugin.iso_z(datetime(2026, 9, 29, 10, 0, 1, 123999, tzinfo=timezone.utc)) == "2026-09-29T10:00:01.123Z"
    assert plugin.age_minutes(None) is None
    n = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
    assert plugin.age_minutes(n - timedelta(minutes=42, seconds=59), n) == 42 and plugin.age_minutes(n + timedelta(minutes=5), n) == 0


# --------------------------------------------------------------- small helpers


def test_round_half_up_matches_javascript(plugin):
    assert [plugin.round_half_up(x) for x in (0.5, 1.5, 2.5, 3.14, 3.5, 0.0, 22 / 7.0, 100 / 7.0)] == [1, 2, 3, 3, 4, 0, 3, 14]


def test_scrub_removes_contact_data_and_truncates(plugin):
    assert plugin.scrub("mail a.b+c@example.invalid now") == "mail [email] now"
    assert plugin.scrub("call +44 7700 900123 or 07700900123") == "call [number] or [number]"
    assert plugin.scrub("order 12345 ok") == "order 12345 ok"
    keep = "since 2026-09-29T10:00:00.123Z in search-1759000000000-aaaaaa.json"
    assert plugin.scrub(keep) == keep
    assert plugin.scrub(None) == "" and plugin.scrub("x" * 400) == "x" * 300 and plugin.scrub("x" * 400, 10) == "x" * 10


def test_settings_parsing_ignores_bad_values(plugin, ws):
    d = plugin.DEFAULT_SETTINGS
    assert plugin.load_settings() == d
    ws.write_json("config/dashboard-settings.json", {
        "zoho_goal": True, "target_per_day": 2.5, "target_per_week": "x", "reed_daily_limit": 0, "stall_minutes": 100000,
        "caterer_expiry": "2027/01/01", "location_mode": "nope", "show_candidate_names": "yes",
        "operating_hours": {"start": 22, "end": 6, "tz": "Bad Zone!"}})
    assert plugin.load_settings() == d
    ws.write_json("config/dashboard-settings.json", {"operating_hours": {"start": 7, "end": 23, "tz": "Europe/Dublin"}, "location_mode": "any",
                                                     "show_candidate_names": True, "disk_warn_pct": 60})
    s = plugin.load_settings()
    assert s["operating_hours"] == {"start": 7, "end": 23, "tz": "Europe/Dublin"} and s["location_mode"] == "any"
    assert s["show_candidate_names"] is True and s["disk_warn_pct"] == 60
    ws.write_text("config/dashboard-settings.json", "[1,2,3]")
    assert plugin.load_settings() == d
    ws.write_text("config/dashboard-settings.json", chr(0xFEFF) + '{"target_per_day": 200}')
    assert plugin.load_settings()["target_per_day"] == 200
    d2 = plugin.load_settings()
    d2["operating_hours"]["start"] = 1
    assert plugin.DEFAULT_SETTINGS["operating_hours"]["start"] == 6


def test_cache_expires(plugin, monkeypatch):
    calls = []
    clock = [1000.0]
    monkeypatch.setattr(plugin.time, "monotonic", lambda: clock[0])
    fn = lambda: calls.append(1) or len(calls)  # noqa: E731
    assert plugin.cached("k", 10.0, fn) == 1 and plugin.cached("k", 10.0, fn) == 1
    clock[0] += 11
    assert plugin.cached("k", 10.0, fn) == 2


def test_read_helpers_swallow_errors(plugin, ws):
    ws.write_text("runtime/x.json", "{not json")
    assert plugin.read_json("runtime", "x.json", default="d") == "d"
    assert plugin.read_json("runtime", "missing.json", default="d") == "d"
    (ws.root / "runtime" / "adir.json").mkdir()
    assert plugin.read_json_state("runtime", "adir.json")[1] == "unreadable"
    assert plugin.read_json_state("runtime", "missing.json") == (None, "missing")
    big = ws.root / "runtime" / "big.json"
    big.write_text('{"a": "' + "x" * (plugin.MAX_JSON_FILE_BYTES + 10) + '"}')
    assert plugin.read_json_state("runtime", "big.json")[1] == "unreadable"
    assert plugin.tail_lines("logs", "nope.jsonl") == []
    ws.write_text("logs/t.jsonl", "".join("line %d\n" % i for i in range(1000)))
    tail = plugin.tail_lines("logs", "t.jsonl", max_bytes=100)
    assert tail[-1] == "line 999" and 5 <= len(tail) <= 12 and not tail[0].startswith("ine")
    assert plugin.parse_jsonl(['{"a":1}', "nope", "[1]", "\ufeff" + '{"b":2}']) == [{"a": 1}, {"b": 2}]


def test_scrub_is_linear_on_hostile_input_and_still_hides_addresses(plugin):
    import time

    t = time.monotonic()
    for hostile in ("a" * 60000, "x@" * 30000, "a." * 30000, "1 " * 30000):
        plugin.scrub(hostile, 300)
    assert time.monotonic() - t < 1.5, "scrub must not run its scans over the whole value"
    assert plugin.scrub("write to jo.fake@mailbox.invalid today") == "write to [email] today"
    assert plugin.scrub("a" * 500, 40) == "a" * 40
