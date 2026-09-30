"""GET /status: the expanded status object, derived only from files the other packages write."""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from conftest import iso, url


def now():
    return datetime.now(timezone.utc)


def ago(**kw):
    return iso(now() - timedelta(**kw))


def events(ws, *rows):
    lines = [json.dumps({"ts": ts, "event": ev, **extra}) for ts, ev, extra in rows]
    ws.write_text("logs/watchdog-runner.jsonl", "\n".join(lines) + "\n")


def get(client):
    r = client.get(url("/status"))
    assert r.status_code == 200, r.text
    return r.json()


def test_empty_workspace_still_returns_a_sane_object(plugin, ws, client):
    j = get(client)
    assert j["halt"] == {"halted": False}
    assert j["activeRuns"] == [] and j["queue"]["depth"] == 0 and j["queue"]["upNext"] == []
    assert j["caterer"]["state"] == "unknown" and j["reed"]["state"] == "unknown"
    assert j["lastPush"]["at"] is None and j["backup"]["stale"] is True and j["backup"]["lastAt"] is None
    assert j["disk"]["available"] is True and 0 <= j["disk"]["percentUsed"] <= 100
    assert j["alerts"] == {"tail": [], "critical24h": 0}
    assert j["db"]["ok"] is False and any("candidates.db" in w for w in j["warnings"])
    assert j["pipeline"]["tz"] == "Europe/London" and j["pipeline"]["operatingHours"] == "06:00-22:00"


def test_missing_directories_do_not_matter(plugin, tmp_path, monkeypatch, client):
    monkeypatch.setenv("RESOURCER_HOME", str(tmp_path / "nothing-here"))
    j = get(client)
    assert j["queue"]["depth"] == 0 and j["activeRuns"] == [] and j["disk"]["available"] is False


def test_halt_state_is_reported_with_duration(plugin, ws, client):
    ws.write_json("runtime/pipeline-halt.json", {"halted": True, "reason": "screening unavailable", "detail": "HTTP 401", "since": ago(minutes=42),
                                                 "lastCheckedAt": ago(minutes=1), "blockedRuns": 3, "remedy": "re-login the gateway"})
    h = get(client)["halt"]
    assert h["halted"] is True and h["reason"] == "screening unavailable" and h["detail"] == "HTTP 401"
    assert h["blockedRuns"] == 3 and h["remedy"] == "re-login the gateway" and h["haltedForMinutes"] in (42, 43)
    ws.write_text("runtime/pipeline-halt.json", "{not json")
    assert get(client)["halt"]["halted"] is False and "readError" in get(client)["halt"]
    ws.write_json("runtime/pipeline-halt.json", {"halted": False})
    assert get(client)["halt"] == {"halted": False}


def test_queue_summary_mirrors_the_gate(plugin, ws, client):
    d = "pending-searches/"
    ws.write_json(d + "search-1759000000000-aaaaaa.json", {"jobTitle": "Sous Chef", "location": "YO2", "distance": 20, "sources": "both", "source": "dashboard", "requestedAt": ago(minutes=5)})
    ws.write_json(d + "territory-1-20260929-0800.json", {"jobTitle": "Head Chef", "location": "LS1", "distance": 20, "sources": "caterer", "source": "queue-due-territories-autocatchup"})
    ws.write_json(d + "territory-2-20260929-0800.json", {"jobTitle": "Chef", "location": "M1", "spawnedAt": ago(minutes=2)})
    ws.write_json(d + "territory-3-20260929-0800.json", {"jobTitle": "Pastry Chef", "location": "B1", "spawnedAt": ago(minutes=30)})
    ws.write_text(d + "territory-4-20260929-0800.json", "{corrupt")
    ws.write_json(d + "territory-5-20260929-0800.json.held", {"jobTitle": "Held", "location": "H1"})
    ws.write_text(d + ".search-x.json.tmp", "{}")
    q = get(client)["queue"]
    assert q["depth"] == 5 and q["claimed"] == 1 and q["dashboardRequests"] == 1 and q["unreadable"] == 1
    assert [i["file"] for i in q["upNext"]] == ["search-1759000000000-aaaaaa.json", "territory-1-20260929-0800.json", "territory-3-20260929-0800.json"]
    assert q["upNext"][0]["jobTitle"] == "Sous Chef" and q["upNext"][0]["source"] == "dashboard"
    assert q["upNext"][2]["claimed"] is True


def test_queue_upnext_is_capped_at_five(plugin, ws, client):
    for i in range(12):
        ws.write_json("pending-searches/territory-%02d-20260929-0800.json" % i, {"jobTitle": "Chef %d" % i, "location": "M1"})
    q = get(client)["queue"]
    assert q["depth"] == 12 and len(q["upNext"]) == 5
    assert q["upNext"][0]["file"] == "territory-00-20260929-0800.json"


def test_active_runs_are_derived_from_run_files(plugin, ws, client):
    n = now()
    p1_started = ago(minutes=20)
    ws.write_json("runs/phase1-%s.json" % n.strftime("%Y-%m-%d-%H%M"), {
        "id": "phase1-x", "status": "phase1_running", "jobTitle": "Sous Chef", "location": "YO2", "distance": 20, "sources": "both",
        "startedAt": ago(minutes=10), "updatedAt": ago(minutes=1), "page": 3, "pool": 11, "approved": 4, "skippedDb": 6, "errors": 0}, mtime_ago_min=1)
    ws.write_json("runs/run-merged-queue-%s.json" % n.strftime("%Y-%m-%dT%H-%M-%S"), {
        "id": "run-y", "status": "phase2_pushing", "jobTitle": "Head Chef", "location": "LS1", "distance": 30, "sources": "caterer",
        "startedAt": ago(minutes=3), "phase1StartedAt": p1_started, "updatedAt": ago(minutes=1),
        "phase2": {"total": 5, "pushed": 2, "duplicates": 1, "errors": 0},
        "candidates": [{"name": "Zed Testerson", "email": "zed@example.invalid"}]}, mtime_ago_min=1)
    ws.write_json("runs/phase1-%s-2.json" % n.strftime("%Y-%m-%d-%H%M"), {
        "id": "phase1-z", "status": "phase1_initializing", "jobTitle": "Chef", "location": "M1", "startedAt": ago(minutes=2), "updatedAt": ago(minutes=2)}, mtime_ago_min=2)
    runs = get(client)["activeRuns"]
    by_stage = {r["stage"]: r for r in runs}
    assert set(by_stage) == {"phase1", "phase2", "initializing"}
    p1 = by_stage["phase1"]
    assert p1["label"] == "Phase 1 - Scraping" and p1["jobTitle"] == "Sous Chef" and p1["distance"] == 20 and p1["sources"] == "both"
    assert p1["phase1"] == {"page": 3, "pool": 11, "approved": 4, "skippedDb": 6, "errors": 0} and p1["phase2"] is None and p1["stale"] is False
    p2 = by_stage["phase2"]
    assert p2["label"] == "Phase 2 - Zoho push" and p2["phase2"] == {"total": 5, "pushed": 2, "duplicates": 1, "errors": 0} and p2["phase1"] is None
    assert p2["startedAt"] == p1_started
    assert by_stage["initializing"]["label"] == "Phase 1 - Logging in"
    assert "Zed Testerson" not in json.dumps(runs) and "example.invalid" not in json.dumps(runs)


def test_run_records_use_the_start_not_the_request_time(plugin, ws, client):
    n = now()
    started = ago(minutes=4)
    ws.write_json("runs/phase1-%s.json" % n.strftime("%Y-%m-%d-%H%M"), {
        "id": "phase1-x", "status": "phase1_running", "jobTitle": "Sous Chef", "location": "YO2", "requestedAt": ago(days=3),
        "startedAt": started, "updatedAt": ago(minutes=1)}, mtime_ago_min=1)
    run = get(client)["activeRuns"][0]
    assert "requestedAt" not in run and run["startedAt"] == started


def test_stale_and_reed_stage_runs(plugin, ws, client):
    n = now()
    stem = n.strftime("%Y-%m-%d-%H%M")
    ws.write_json("runs/phase1-%s.json" % stem, {"id": "a", "status": "phase1_running", "jobTitle": "Sous Chef", "location": "YO2", "startedAt": ago(minutes=100),
                                                 "updatedAt": ago(minutes=75)}, mtime_ago_min=75)
    ws.write_json("runs/phase1-%s-b.json" % stem, {"id": "b", "status": "phase1_complete", "phase2Status": "pending", "sources": "both", "jobTitle": "Head Chef",
                                                   "location": "LS1", "startedAt": ago(minutes=40), "updatedAt": ago(minutes=20)}, mtime_ago_min=20)
    runs = {r["id"]: r for r in get(client)["activeRuns"]}
    assert runs["a"]["stale"] is True and runs["a"]["idleSecs"] >= 75 * 60
    assert runs["b"]["stage"] == "reed" and runs["b"]["label"] == "Phase 1 done - Reed / hand-off" and runs["b"]["stale"] is False


def test_completed_runs_and_old_files_are_not_active(plugin, ws, client):
    n = now()
    stem = n.strftime("%Y-%m-%d-%H%M")
    ws.write_json("runs/phase1-%s.json" % stem, {"id": "a", "status": "complete", "jobTitle": "Sous Chef", "location": "YO2", "updatedAt": ago(minutes=1)}, mtime_ago_min=1)
    ws.write_json("runs/phase1-%s-x.json" % stem, {"id": "b", "status": "phase1_abandoned", "jobTitle": "Sous Chef", "location": "YO3", "updatedAt": ago(minutes=1)}, mtime_ago_min=1)
    ws.write_json("runs/phase1-2020-01-01-0000.json", {"id": "c", "status": "phase1_running", "jobTitle": "Old", "location": "O1", "updatedAt": ago(minutes=1)}, mtime_ago_min=1)
    ws.write_json("runs/params-watchdog-x.json", {"status": "phase1_running", "jobTitle": "Nope", "location": "N1"})
    assert get(client)["activeRuns"] == []


def test_caterer_state_from_watchdog_events(plugin, ws, client):
    t = lambda m: ago(minutes=m)  # noqa: E731
    events(ws, (t(50), "session-loaded", {"state": "ok"}))
    assert get(client)["caterer"]["state"] == "ok"
    events(ws, (t(50), "session-loaded", {}), (t(30), "session-safelist-blocked", {"note": "needs a fresh verification link"}))
    c = get(client)["caterer"]
    assert c["state"] == "safelist_blocked" and c["source"] == "logs/watchdog-runner.jsonl" and c["ageMinutes"] in (30, 31)
    events(ws, (t(30), "session-safelist-blocked", {}), (t(30), "session-dead", {"note": "browser blocked at SafeListLoginBlocked - paste a fresh verification link"}))
    assert get(client)["caterer"]["state"] == "safelist_blocked"
    events(ws, (t(30), "session-dead", {"note": "saved session is logged OUT - manual re-login required"}))
    assert get(client)["caterer"]["state"] == "stale"
    events(ws, (t(30), "session-stale", {}), (t(10), "session-relogin", {"note": "attempting one inline re-login"}))
    assert get(client)["caterer"]["state"] == "relogin"
    events(ws, (t(30), "session-safelist-blocked", {}), (t(5), "done", {"exitCode": 0}))
    assert get(client)["caterer"]["state"] == "ok"
    events(ws, (t(5), "picked", {}), (t(4), "marked-spawned", {}))
    assert get(client)["caterer"]["state"] == "unknown"


def test_explicit_caterer_status_file_wins_only_when_newer(plugin, ws, client):
    events(ws, (ago(minutes=30), "session-loaded", {}))
    ws.write_json("runtime/caterer-status.json", {"state": "safelist_blocked", "updatedAt": ago(minutes=10), "detail": "waiting for the emailed link"})
    c = get(client)["caterer"]
    assert c["state"] == "safelist_blocked" and c["source"] == "runtime/caterer-status.json" and c["detail"] == "waiting for the emailed link"
    ws.write_json("runtime/caterer-status.json", {"state": "stale", "updatedAt": ago(minutes=90)})
    assert get(client)["caterer"]["state"] == "ok"
    ws.write_json("runtime/caterer-status.json", {"status": "legacy run record", "jobTitle": "x"})
    assert get(client)["caterer"]["state"] == "ok"


def test_reed_state_from_marker_status_file_and_run_results(plugin, ws, client, db):
    j = get(client)
    assert j["reed"]["state"] == "ok" and j["reed"]["source"] == "run_results"
    ws.write_json("runtime/reed-auth-failed.marker", {"reason": "token refresh failed", "failedAt": ago(minutes=5), "jobTitle": "Chef", "location": "M1"})
    r = get(client)["reed"]
    assert r["state"] == "auth_failed" and r["detail"] == "token refresh failed" and r["source"] == "reed-auth-failed.marker"
    ws.write_json("runtime/reed-auth-failed.marker", {"reason": "old failure", "failedAt": ago(days=3)})
    assert get(client)["reed"]["state"] == "ok"
    os.unlink(ws.root / "runtime" / "reed-auth-failed.marker")
    ws.write_json("reed-auth-failed.marker", {"reason": "root marker", "failedAt": ago(minutes=1)})
    assert get(client)["reed"]["state"] == "auth_failed"
    os.unlink(ws.root / "reed-auth-failed.marker")
    ws.write_json("runtime/reed-status.json", {"state": "disabled", "updatedAt": ago(minutes=1), "detail": "RESOURCER_SOURCES=caterer"})
    r = get(client)["reed"]
    assert r["state"] == "disabled" and r["source"] == "runtime/reed-status.json"


def test_reed_state_unknown_without_any_signal(plugin, ws, client):
    ws.make_db()
    assert get(client)["reed"]["state"] == "unknown"


def test_last_push_prefers_run_results_then_candidates(plugin, ws, client, db):
    j = get(client)["lastPush"]
    assert j["source"] == "run_results" and j["at"] is not None and isinstance(j["ageMinutes"], int) and j["ageMinutes"] >= 0
    ws2_con = ws.connect()
    ws2_con.execute("DROP TABLE run_results")
    ws2_con.commit()
    ws2_con.close()
    plugin._CACHE.clear()
    j = get(client)["lastPush"]
    assert j["source"] == "candidates" and j["at"].startswith(db["today"])


def test_status_db_lookups_are_cached_briefly(plugin, ws, client, db):
    first = get(client)["lastPush"]["at"]
    con = ws.connect()
    con.execute("UPDATE run_results SET completed_at = '2099-01-01T00:00:00.000Z' WHERE run_key = 'merged-queue-a'")
    con.commit()
    con.close()
    assert get(client)["lastPush"]["at"] == first
    plugin._CACHE.clear()
    assert get(client)["lastPush"]["at"] == "2099-01-01T00:00:00.000Z"


def test_backup_age_and_staleness(plugin, ws, client):
    b = ws.root / "backups"
    assert get(client)["backup"] == {"count": 0, "lastAt": None, "ageHours": None, "file": None, "stale": True, "source": "files"}

    def put(rel, hours):
        p = b / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
        ts = (now() - timedelta(hours=hours)).timestamp()
        os.utime(p, (ts, ts))

    put("candidates-20260929.db.gz.enc", 2)
    put("daily/candidates-20260928.db.gz.enc", 30)
    put("candidates-partial.db.gz.enc.tmp", 0)
    put(".hidden", 0)
    put("latest.json", 0)
    j = get(client)["backup"]
    assert j["count"] == 2 and j["file"] == "candidates-20260929.db.gz.enc" and 1.9 <= j["ageHours"] <= 2.2 and j["stale"] is False
    for p in b.rglob("*"):
        if p.is_file() and p.name.endswith(".enc"):
            ts = (now() - timedelta(hours=40)).timestamp()
            os.utime(p, (ts, ts))
    assert get(client)["backup"]["stale"] is True
    put("candidates-20260929.db.gz.enc", 1)
    ws.write_json("runtime/backup-status.json", {"ok": False, "finishedAt": ago(minutes=5), "error": "integrity check failed"})
    j = get(client)["backup"]
    assert j["stale"] is True and j["lastResultOk"] is False and j["lastError"] == "integrity check failed"


def test_pre_migrate_copies_and_bundle_restore_copies_are_not_backups(plugin, ws, client):
    b = ws.root / "backups"
    (b / "bundle-restore-20260929T100000Z").mkdir(parents=True)
    for rel in ("candidates.db.pre-migrate-2026-09-29T10-00-00-000Z", "bundle-restore-20260929T100000Z/candidates.db"):
        (b / rel).write_bytes(b"SQLite format 3")
    j = get(client)["backup"]
    assert j["count"] == 0 and j["lastAt"] is None and j["stale"] is True, "an unencrypted safety copy must not look like a fresh nightly backup"
    (b / "candidates-20260929-030000.db.gz.enc").write_bytes(b"x")
    j = get(client)["backup"]
    assert j["count"] == 1 and j["file"] == "candidates-20260929-030000.db.gz.enc" and j["stale"] is False


@pytest.mark.parametrize("used, level", [(10, "ok"), (74, "ok"), (75, "warn"), (84, "warn"), (85, "critical"), (99, "critical")])
def test_disk_levels(plugin, ws, monkeypatch, used, level):
    import shutil
    from collections import namedtuple
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(100, used, 100 - used))
    d = plugin.disk_state(plugin.load_settings())
    assert d["level"] == level and d["percentUsed"] == float(used) and d["freeBytes"] == 100 - used


def test_alerts_tail_and_critical_count(plugin, ws, client):
    rows = []
    for i in range(20):
        rows.append({"ts": ago(minutes=100 - i), "severity": "critical" if i % 5 == 0 else "info", "key": "k%d" % i, "text": "alert %d" % i})
    rows.append({"ts": ago(days=3), "severity": "critical", "key": "old", "text": "old critical"})
    ws.write_text("outbox/alerts.jsonl", "\n".join(json.dumps(r) for r in rows[:10]) + "\nnot json\n" + "\n".join(json.dumps(r) for r in rows[10:]) + "\n")
    a = get(client)["alerts"]
    assert len(a["tail"]) == 15 and a["tail"][0]["text"] == "old critical"
    assert a["critical24h"] == 4
    assert [x["text"] for x in a["tail"][1:3]] == ["alert 19", "alert 18"]


def test_alert_text_is_scrubbed_and_normalised(plugin, ws, client):
    ws.write_text("outbox/alerts.jsonl", json.dumps({"ts": ago(minutes=1), "severity": "URGENT", "key": "k", "text": "Zed Testerson zed@example.invalid 07700 900123 " + "x" * 500}) + "\n")
    a = get(client)["alerts"]["tail"][0]
    assert a["severity"] == "info" and "example.invalid" not in a["text"] and "900123" not in a["text"] and len(a["text"]) <= 300


def test_stall_detection(plugin, ws, client):
    ws.write_json("config/dashboard-settings.json", {"operating_hours": {"start": 0, "end": 24, "tz": "Europe/London"}, "stall_minutes": 20})
    assert get(client)["pipeline"]["stallSuspected"] is False
    ws.write_json("pending-searches/territory-1-20260929-0800.json", {"jobTitle": "Chef", "location": "M1"})
    p = get(client)["pipeline"]
    assert p["inOperatingHours"] is True and p["stallSuspected"] is True and p["lastActivityAt"] is None
    events(ws, (ago(minutes=2), "picked", {}))
    p = get(client)["pipeline"]
    assert p["stallSuspected"] is False and p["lastActivityAgeMinutes"] in (2, 3)
    events(ws, (ago(minutes=45), "gate-not-ready", {}))
    assert get(client)["pipeline"]["stallSuspected"] is True
    ws.write_json("runtime/pipeline-halt.json", {"halted": True, "reason": "x", "since": ago(minutes=1)})
    assert get(client)["pipeline"]["stallSuspected"] is False
    os.unlink(ws.root / "runtime" / "pipeline-halt.json")
    ws.write_json("config/dashboard-settings.json", {"operating_hours": {"start": 0, "end": 1, "tz": "UTC"}})
    hour = now().hour
    expected_inside = hour < 1
    assert get(client)["pipeline"]["inOperatingHours"] is expected_inside


def test_heartbeat_file_counts_as_activity(plugin, ws, client):
    ws.write_text("runtime/watchdog.heartbeat", "1")
    p = get(client)["pipeline"]
    assert p["lastActivityAgeMinutes"] == 0 and p["lastActivityAt"]


def test_status_is_free_of_candidate_data(plugin, ws, client, db):
    ws.write_text("logs/errors.jsonl", json.dumps({"ts": ago(minutes=1), "context": "zoho_push", "error": "dup for Zed Testerson zed@example.invalid",
                                                   "name": "Zed Testerson", "candidateId": "12345"}) + "\n")
    text = client.get(url("/status")).text
    assert "Zed Testerson" not in text and "example.invalid" not in text and "12345" not in text
