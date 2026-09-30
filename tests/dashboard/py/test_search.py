"""POST /search: validation vectors (shared with the Node tool), duplicates, atomic no-clobber writes, locking."""
import errno
import json
import os
import re
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from conftest import FIXTURES, REPO, build_app, iso, url

VECTORS = json.loads((FIXTURES / "search-vectors.json").read_text(encoding="utf-8"))
DUPES = json.loads((FIXTURES / "duplicate-cases.json").read_text(encoding="utf-8"))
NODE = shutil.which("node")
FILE_RE = re.compile(r"^search-\d{13}-[0-9a-f]{6}\.json$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
KEY_ORDER = ["jobTitle", "location", "keywords", "priority", "sources", "distance", "activeWithin", "cvLimit", "overrides",
             "requestedAt", "source", "requestedBy"]


def pending_files(ws):
    return sorted(p.name for p in (ws.root / "pending-searches").iterdir())


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_shared_validation_vectors(plugin, case):
    defaults = case.get("defaults", VECTORS["defaults"])
    mode = case.get("mode", "outward")
    if "ok" in case:
        assert plugin.validate_search(case["input"], defaults, mode) == case["ok"]
    else:
        with pytest.raises(plugin.ValidationError) as info:
            plugin.validate_search(case["input"], defaults, mode)
        assert info.value.field == case["error"]
        assert info.value.detail


def test_success_writes_exactly_the_documented_file(plugin, ws, client):
    r = client.post(url("/search"), json={"jobTitle": "sous chef", "location": "yo2", "keywords": "DBS", "sources": "caterer",
                                          "priority": "high", "distance": 30, "activeWithin": "3 months", "cvLimit": 40})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and FILE_RE.match(body["file"])
    assert body["queueDepthAfter"] == 1 and body["position"] == 1 and body["pipelineHalted"] is False
    assert isinstance(body["inOperatingHours"], bool) and isinstance(body["note"], str) and body["note"]
    assert pending_files(ws) == [body["file"]]
    path = ws.root / "pending-searches" / body["file"]
    raw = path.read_text(encoding="utf-8")
    assert not raw.startswith(chr(0xFEFF)) and "\r" not in raw
    on_disk = json.loads(raw)
    assert list(on_disk) == KEY_ORDER
    assert on_disk == body["request"]
    assert "spawnedAt" not in on_disk
    assert on_disk["source"] == "dashboard" and ISO_RE.match(on_disk["requestedAt"])
    assert on_disk["jobTitle"] == "Sous Chef" and on_disk["location"] == "YO2" and on_disk["keywords"] == "dbs"
    assert on_disk["overrides"] == ["distance", "activeWithin", "cvLimit"]
    assert (path.stat().st_mode & 0o444) == 0o444


def test_client_supplied_bookkeeping_fields_are_ignored(plugin, ws, client):
    r = client.post(url("/search"), json={"jobTitle": "Chef", "location": "LS1", "spawnedAt": "2099-01-01T00:00:00.000Z",
                                          "source": "territory-scheduler", "requestedAt": "1999-01-01T00:00:00.000Z",
                                          "overrides": ["x"], "id": 7, "extra": {"a": 1}, "requestedBy": "forged"})
    assert r.status_code == 200
    data = json.loads((ws.root / "pending-searches" / r.json()["file"]).read_text(encoding="utf-8"))
    assert list(data) == KEY_ORDER
    assert data["source"] == "dashboard" and data["requestedAt"].startswith(str(datetime.now(timezone.utc).year))
    assert data["overrides"] == []


@pytest.mark.parametrize("body, field", [
    ({"location": "M1"}, "jobTitle"),
    ({"jobTitle": "Chef"}, "location"),
    ({"jobTitle": "Chef", "location": "York"}, "location"),
    ({"jobTitle": "Chef", "location": "M1", "distance": 15}, "distance"),
    ({"jobTitle": "Chef", "location": "M1", "sources": "all"}, "sources"),
    ({"jobTitle": "Chef", "location": "M1", "cvLimit": 500}, "cvLimit"),
    ({}, "jobTitle"),
])
def test_validation_errors_are_400_and_write_nothing(plugin, ws, client, body, field):
    r = client.post(url("/search"), json=body)
    assert r.status_code == 400
    j = r.json()
    assert j["error"] == "validation" and j["field"] == field and isinstance(j["detail"], str)
    assert pending_files(ws) == []


def test_content_type_must_be_json(plugin, ws, client):
    payload = json.dumps({"jobTitle": "Chef", "location": "M1"}).encode()
    for headers in ({"content-type": "text/plain"}, {"content-type": "application/x-www-form-urlencoded"}, {}):
        r = client.post(url("/search"), content=payload, headers=headers)
        assert r.status_code == 415, headers
        assert r.json()["error"] == "unsupported_media_type"
    assert client.post(url("/search"), content=payload, headers={"content-type": "application/json; charset=utf-8"}).status_code == 200
    assert len(pending_files(ws)) == 1


def test_body_limits_and_bad_json(plugin, ws, client):
    big = client.post(url("/search"), content=b'{"jobTitle": "' + b"x" * 5000 + b'"}', headers={"content-type": "application/json"})
    assert big.status_code == 413 and big.json()["error"] == "payload_too_large"
    bad = client.post(url("/search"), content=b"{not json", headers={"content-type": "application/json"})
    assert bad.status_code == 400 and bad.json()["error"] == "bad_json"
    arr = client.post(url("/search"), content=b"[1,2]", headers={"content-type": "application/json"})
    assert arr.status_code == 400 and arr.json()["error"] == "bad_json"
    assert pending_files(ws) == []


def test_second_identical_request_is_409(plugin, ws, client):
    first = client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"})
    assert first.status_code == 200
    second = client.post(url("/search"), json={"jobTitle": "sous  chef", "location": "yo2", "distance": 40, "keywords": "dbs"})
    assert second.status_code == 409
    j = second.json()
    assert j["error"] == "already_queued" and j["file"] == first.json()["file"]
    assert j["existing"]["where"] == "pending" and j["existing"]["jobTitle"] == "Sous Chef"
    assert pending_files(ws) == [first.json()["file"]]


def test_position_counts_unclaimed_files_ahead(plugin, ws, client):
    ws.write_json("pending-searches/territory-9-20260929-0800.json", {"jobTitle": "A", "location": "B1"})
    first = client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"}).json()
    assert first["position"] == 1 and first["queueDepthAfter"] == 2
    second = client.post(url("/search"), json={"jobTitle": "Head Chef", "location": "LS1"}).json()
    assert second["position"] == 2 and second["queueDepthAfter"] == 3


def test_claimed_files_do_not_count_for_position(plugin, ws, client):
    ws.write_json("pending-searches/search-1000000000000-aaaaaa.json",
                  {"jobTitle": "A", "location": "B1", "spawnedAt": iso(datetime.now(timezone.utc) - timedelta(minutes=2))})
    r = client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"}).json()
    assert r["position"] == 1 and r["queueDepthAfter"] == 2


def test_search_names_sort_ahead_of_scheduled_territories(plugin):
    early = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
    late = early + timedelta(seconds=1)
    names = [plugin.new_search_filename(late), "territory-1-20260929-0800.json", plugin.new_search_filename(early)]
    ordered = sorted(names)
    assert ordered[0].startswith("search-") and ordered[1].startswith("search-") and ordered[2].startswith("territory-")
    assert ordered[0] < ordered[1]


def test_pipeline_halt_is_reported_but_request_is_accepted(plugin, ws, client):
    ws.write_json("runtime/pipeline-halt.json", {"halted": True, "reason": "screening down", "since": iso(datetime.now(timezone.utc))})
    r = client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"})
    assert r.status_code == 200
    assert r.json()["pipelineHalted"] is True and "halted" in r.json()["note"].lower()


def test_location_mode_any_from_settings(plugin, ws, client):
    assert client.post(url("/search"), json={"jobTitle": "Chef", "location": "Harrogate"}).status_code == 400
    ws.write_json("config/dashboard-settings.json", {"location_mode": "any"})
    ok = client.post(url("/search"), json={"jobTitle": "Chef", "location": "Harrogate"})
    assert ok.status_code == 200 and ok.json()["request"]["location"] == "HARROGATE"
    ws.write_json("config/dashboard-settings.json", {"location_mode": "bogus"})
    assert client.post(url("/search"), json={"jobTitle": "Chef", "location": "Ripon"}).status_code == 400


def test_defaults_come_from_territory_defaults_file(plugin, ws, client):
    ws.write_json("config/territory-defaults.json", {"distance": 30, "activeWithin": "2 months", "cvLimit": 30, "priority": "medium", "sources": "caterer"})
    r = client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1"})
    assert r.status_code == 200
    req = r.json()["request"]
    assert (req["distance"], req["activeWithin"], req["cvLimit"], req["priority"], req["sources"]) == (30, "2 months", 30, "medium", "caterer")
    assert req["overrides"] == []
    ws.write_json("config/territory-defaults.json", {"distance": 17, "cvLimit": 999, "priority": "urgent", "sources": "x"})
    fresh = client.post(url("/search"), json={"jobTitle": "Head Chef", "location": "M2"}).json()["request"]
    assert (fresh["distance"], fresh["cvLimit"], fresh["priority"], fresh["sources"]) == (20, 20, "low", "both")


# --------------------------------------------------------------- shared duplicate / in-flight cases


def materialise(ws, files, now):
    def conv(value):
        if isinstance(value, dict):
            if set(value) == {"$agoMin"}:
                return iso(now - timedelta(minutes=value["$agoMin"]))
            return {k: conv(v) for k, v in value.items()}
        if isinstance(value, list):
            return [conv(v) for v in value]
        return value

    for f in files:
        path = ws.root / f["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        if "text" in f:
            path.write_text(f["text"], encoding="utf-8")
        else:
            path.write_text(json.dumps(conv(f["json"])), encoding="utf-8")
        if "mtimeAgoMin" in f:
            ts = (now - timedelta(minutes=f["mtimeAgoMin"])).timestamp()
            os.utime(path, (ts, ts))


@pytest.mark.parametrize("case", DUPES["cases"], ids=lambda c: c["name"])
def test_shared_duplicate_cases(plugin, ws, case):
    now = datetime.fromisoformat(DUPES["now"].replace("Z", "+00:00"))
    materialise(ws, case["files"], now)
    status, body = plugin.enqueue_search(dict(DUPES["request"]), plugin.load_settings(), now=now)
    assert status == case["expect"]["status"], body
    if status == 409:
        assert body["error"] == "already_queued"
        assert body["existing"]["where"] == case["expect"]["where"]
        if "file" in case["expect"]:
            assert body["file"] == case["expect"]["file"]
    else:
        assert body["ok"] is True and body["request"]["requestedAt"] == iso(now)


# --------------------------------------------------------------- atomic writes and locking


def test_temp_file_is_never_visible_as_json_and_final_is_complete(plugin, ws, client, monkeypatch):
    seen = []
    real_fsync = os.fsync

    def spy(fd):
        seen.append(sorted(n for n in os.listdir(ws.root / "pending-searches") if n.endswith(".json")))
        return real_fsync(fd)

    monkeypatch.setattr(os, "fsync", spy)
    r = client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1"})
    assert r.status_code == 200
    assert seen and seen[0] == []
    assert json.loads((ws.root / "pending-searches" / r.json()["file"]).read_text())["jobTitle"] == "Chef"
    assert pending_files(ws) == [r.json()["file"]]


def test_write_new_file_atomic_never_overwrites(plugin, ws, tmp_path):
    d = tmp_path / "dir"
    d.mkdir()
    (d / "a.json").write_text("original")
    names = iter(["a.json", "b.json"])
    assert plugin.write_new_file_atomic(d, lambda: next(names), "new") == "b.json"
    assert (d / "a.json").read_text() == "original" and (d / "b.json").read_text() == "new"
    assert sorted(p.name for p in d.iterdir()) == ["a.json", "b.json"]
    with pytest.raises(OSError):
        plugin.write_new_file_atomic(d, lambda: "a.json", "x")
    assert (d / "a.json").read_text() == "original"
    assert sorted(p.name for p in d.iterdir()) == ["a.json", "b.json"]


def test_write_new_file_atomic_falls_back_when_hard_links_are_unsupported(plugin, ws, tmp_path, monkeypatch):
    d = tmp_path / "dir"
    d.mkdir()

    def no_link(src, dst):
        raise OSError(errno.EPERM, "links not supported")

    monkeypatch.setattr(os, "link", no_link)
    assert plugin.write_new_file_atomic(d, lambda: "c.json", "hello") == "c.json"
    assert (d / "c.json").read_text() == "hello"
    assert [p.name for p in d.iterdir()] == ["c.json"]


def test_concurrent_identical_requests_produce_one_file(plugin, ws):
    app = build_app(plugin)

    def post(_):
        return TestClient(app).post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"}).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(post, range(8)))
    assert sorted(codes) == [200] + [409] * 7
    assert len(pending_files(ws)) == 1


def test_concurrent_distinct_requests_all_succeed_with_unique_names(plugin, ws):
    app = build_app(plugin)
    titles = ["Chef %d" % i for i in range(10)]

    def post(title):
        return TestClient(app).post(url("/search"), json={"jobTitle": title, "location": "YO2"}).json()

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(post, titles))
    assert all(r.get("ok") for r in results), results
    files = pending_files(ws)
    assert len(files) == 10 and len(set(files)) == 10 and all(FILE_RE.match(f) for f in files)


def test_stale_lock_is_taken_over_and_released(plugin, ws, client):
    lock = ws.root / "pending-searches" / ".request-search.lock"
    lock.write_text("1 1")
    old = datetime.now(timezone.utc).timestamp() - 120
    os.utime(lock, (old, old))
    assert client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1"}).status_code == 200
    assert not lock.exists()


def test_fresh_lock_gives_503_and_is_left_alone(plugin, ws, client, monkeypatch):
    monkeypatch.setattr(plugin, "LOCK_WAIT_SECS", 0.2)
    lock = ws.root / "pending-searches" / ".request-search.lock"
    lock.write_text("1 1")
    r = client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1"})
    assert r.status_code == 503 and r.json()["error"] == "busy" and r.headers["retry-after"] == "2"
    assert lock.exists() and pending_files(ws) == [".request-search.lock"]


# --------------------------------------------------------------- cross-implementation checks (need node)


needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed")


@needs_node
def test_pending_gate_picks_the_dashboard_request_first(plugin, ws, client):
    for i in range(3):
        ws.write_json("pending-searches/territory-%d-20260929-0800.json" % i, {"jobTitle": "Chef %d" % i, "location": "B%d" % (i + 1), "sources": "caterer"})
    r = client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2", "sources": "both"})
    assert r.status_code == 200
    gate = REPO / "resourcer" / "scripts" / "pending-gate.js"
    if not gate.exists():
        pytest.skip("pending-gate.js is not in this checkout")
    out = subprocess.run([NODE, str(gate)], capture_output=True, text=True, env={**os.environ, "RESOURCER_HOME": str(ws.root)}, timeout=60)
    assert out.returncode == 0, out.stderr
    ready = json.loads(out.stdout)
    assert ready["status"] == "READY" and ready["file"] == r.json()["file"]
    assert ready["pending"]["jobTitle"] == "Sous Chef" and ready["pending"]["sources"] == "both"
    assert "spawnedAt" not in ready["pending"] and ready["queueDepth"] == 4


@needs_node
def test_plugin_and_cli_share_the_lock_and_the_duplicate_rule(plugin, ws):
    tool = REPO / "tools" / "request-search.js"
    app = build_app(plugin)
    env = {**os.environ, "RESOURCER_HOME": str(ws.root)}
    results = []
    lock = threading.Lock()

    def via_api(_):
        code = TestClient(app).post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"}).status_code
        with lock:
            results.append(("api", code))

    def via_cli(_):
        p = subprocess.run([NODE, str(tool), "--job", "Sous Chef", "--location", "YO2"], capture_output=True, text=True, env=env, timeout=120)
        with lock:
            results.append(("cli", p.returncode))

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(via_api, i) for i in range(3)] + [pool.submit(via_cli, i) for i in range(3)]
        for f in futures:
            f.result()
    ok = [r for r in results if (r[0] == "api" and r[1] == 200) or (r[0] == "cli" and r[1] == 0)]
    dup = [r for r in results if (r[0] == "api" and r[1] == 409) or (r[0] == "cli" and r[1] == 3)]
    assert len(ok) == 1 and len(dup) == 5, results
    assert len(pending_files(ws)) == 1


@pytest.mark.parametrize("raw", [
    b'{"jobTitle":"Chef","location":"M1","distance":NaN}',
    b'{"jobTitle":"Chef","location":"M1","distance":Infinity}',
    b'{"jobTitle":"Chef","location":"M1","cvLimit":-Infinity}',
    b'{"jobTitle":"Chef","location":"M1","distance":1e999}',
])
def test_non_finite_numbers_are_validation_errors_not_crashes(plugin, ws, client, raw):
    r = client.post(url("/search"), content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 400 and r.json()["error"] == "validation", r.text
    assert pending_files(ws) == []


def test_lock_release_only_removes_our_own_lock(plugin, ws, client, monkeypatch):
    real = plugin.find_duplicate
    lock = ws.root / "pending-searches" / ".request-search.lock"

    def takes_over(*args, **kwargs):
        lock.write_text("999 1 someone-elses-token")
        return real(*args, **kwargs)

    monkeypatch.setattr(plugin, "find_duplicate", takes_over)
    assert client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1"}).status_code == 200
    assert lock.read_text() == "999 1 someone-elses-token"


# ---- review fixes: who asked, queue cap, cross-site guard -------------------------------------------------------------

def put_pending(ws, n, source, claimed=False, prefix="q"):
    d = ws.root / "pending-searches"
    for i in range(n):
        data = {"jobTitle": "Role %s%d" % (prefix, i), "location": "LS%d" % (i % 90 + 1), "source": source,
                "requestedAt": iso(datetime.now(timezone.utc))}
        if claimed:
            data["spawnedAt"] = iso(datetime.now(timezone.utc))
        (d / ("%s-%s-%03d.json" % (source, prefix, i))).write_text(json.dumps(data), encoding="utf-8")


def test_request_records_who_asked_and_a_client_cannot_forge_it(plugin, ws, client, monkeypatch):
    monkeypatch.setattr(plugin, "_actor", lambda request: "user-42")
    r = client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1", "requestedBy": "someone-else"})
    assert r.status_code == 200, r.text
    data = json.loads((ws.root / "pending-searches" / r.json()["file"]).read_text(encoding="utf-8"))
    assert data["requestedBy"] == "user-42" and data["source"] == "dashboard"
    assert r.json()["request"]["requestedBy"] == "user-42"


def test_queue_cap_turns_the_26th_waiting_manual_search_away_with_429(plugin, ws, client):
    put_pending(ws, plugin.SEARCH_QUEUE_CAP, "dashboard")
    before = pending_files(ws)
    r = client.post(url("/search"), json={"jobTitle": "Fresh Title", "location": "M1"})
    assert r.status_code == 429, r.text
    body = r.json()
    assert body["error"] == "queue_full" and body["waiting"] == plugin.SEARCH_QUEUE_CAP == 25 and body["limit"] == 25
    assert pending_files(ws) == before, "nothing is written when the queue is full"


def test_queue_cap_counts_only_waiting_manual_searches(plugin, ws, client):
    put_pending(ws, 40, "territory-scheduler", prefix="t")
    put_pending(ws, 10, "dashboard", claimed=True, prefix="c")
    put_pending(ws, plugin.SEARCH_QUEUE_CAP - 1, "request-search-cli", prefix="m")
    r = client.post(url("/search"), json={"jobTitle": "Fresh Title", "location": "M1"})
    assert r.status_code == 200, r.text
    assert client.post(url("/search"), json={"jobTitle": "Another Title", "location": "M2"}).status_code == 429


def test_cli_and_dashboard_share_the_same_cap_and_sources(plugin):
    assert plugin.SEARCH_QUEUE_CAP == 25 and set(plugin.MANUAL_SOURCES) == {"dashboard", "request-search-cli"}
    js = (REPO / "tools" / "request-search.js").read_text(encoding="utf-8")
    assert "SEARCH_QUEUE_CAP = 25" in js and "'request-search-cli'" in js


@pytest.mark.parametrize("route, body", [("/search", {"jobTitle": "Chef", "location": "M1"}), ("/halt/clear", {}), ("/errors/ack", {})])
@pytest.mark.parametrize("site", ["cross-site", "same-site"])
def test_cross_site_posts_are_refused_before_anything_happens(plugin, ws, client, route, body, site):
    r = client.post(url(route), json=body, headers={"Sec-Fetch-Site": site})
    assert r.status_code == 403 and r.json()["error"] == "cross_site", r.text
    assert pending_files(ws) == []


@pytest.mark.parametrize("site", ["same-origin", "none", ""])
def test_same_origin_and_non_browser_posts_still_work(plugin, ws, client, site):
    headers = {"Sec-Fetch-Site": site} if site else {}
    assert client.post(url("/search"), json={"jobTitle": "Chef", "location": "M1"}, headers=headers).status_code == 200
