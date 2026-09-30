"""POST /halt/clear (same file protocol as lib/pipeline-halt.js), GET /halt, GET /errors and POST /errors/ack."""
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone

import pytest

from conftest import REPO, iso, url

NODE = shutil.which("node")
HALT_LIB = REPO / "resourcer" / "scripts" / "lib" / "pipeline-halt.js"


def ago(**kw):
    return iso(datetime.now(timezone.utc) - timedelta(**kw))


def lines(path):
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def put_halt(ws, minutes=42, blocked=3):
    ws.write_json("runtime/pipeline-halt.json", {"halted": True, "reason": "screening unavailable", "detail": "HTTP 401 from the gateway",
                                                 "since": ago(minutes=minutes), "lastCheckedAt": ago(minutes=1), "blockedRuns": blocked,
                                                 "remedy": "re-authenticate the model gateway"})


def test_get_halt_shapes(plugin, ws, client):
    assert client.get(url("/halt")).json() == {"halted": False}
    put_halt(ws)
    h = client.get(url("/halt")).json()
    assert h["halted"] is True and h["reason"] == "screening unavailable" and h["blockedRuns"] == 3
    assert h["remedy"] == "re-authenticate the model gateway" and h["haltedForMinutes"] in (42, 43)
    ws.write_text("runtime/pipeline-halt.json", "{oops")
    assert client.get(url("/halt")).json()["halted"] is False


def test_clear_halt_follows_the_pipeline_halt_protocol(plugin, ws, client):
    put_halt(ws)
    (ws.root / "logs" / "errors.jsonl").write_text(json.dumps({"ts": ago(hours=1), "context": "cv_download", "error": "earlier"}) + "\n")
    r = client.post(url("/halt/clear"), json={})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["ok"] is True and j["cleared"] is True
    assert j["previous"] == {"reason": "screening unavailable", "detail": "HTTP 401 from the gateway", "since": j["previous"]["since"], "blockedRuns": 3}
    assert not (ws.root / "runtime" / "pipeline-halt.json").exists()

    errs = lines(ws.root / "logs" / "errors.jsonl")
    assert len(errs) == 2 and errs[0]["context"] == "cv_download"
    e = errs[1]
    assert e["context"] == "pipeline_resumed" and e["severity"] == "info"
    assert e["error"] == "Pipeline resumed " + chr(0x2014) + " screening unavailable cleared"
    assert re.fullmatch(r"was halted for \d+ min; 3 run\(s\) held back \(their territories were NOT consumed\)", e["detail"])
    assert e["via"] == "dashboard" and e["by"] == "dashboard-user" and re.match(r"^\d{4}-\d\d-\d\dT[\d:.]+Z$", e["ts"])

    alerts = lines(ws.root / "outbox" / "alerts.jsonl")
    assert len(alerts) == 1
    a = alerts[0]
    assert a["severity"] == "info" and a["key"] == "pipeline-halt" and a["meta"]["event"] == "resumed" and a["meta"]["reason"] == "screening unavailable"
    assert a["text"].startswith("Pipeline resumed - screening unavailable cleared. was halted for ")

    again = client.post(url("/halt/clear"), json={})
    assert again.status_code == 200 and again.json() == {"ok": True, "cleared": False}
    assert len(lines(ws.root / "logs" / "errors.jsonl")) == 2 and len(lines(ws.root / "outbox" / "alerts.jsonl")) == 1


def test_clear_halt_creates_missing_log_directories(plugin, ws, client):
    shutil.rmtree(ws.root / "logs")
    shutil.rmtree(ws.root / "outbox")
    put_halt(ws)
    assert client.post(url("/halt/clear"), json={}).json()["cleared"] is True
    assert len(lines(ws.root / "logs" / "errors.jsonl")) == 1 and len(lines(ws.root / "outbox" / "alerts.jsonl")) == 1


def test_clear_halt_leaves_unreadable_or_not_halted_files_alone(plugin, ws, client):
    ws.write_text("runtime/pipeline-halt.json", "{oops")
    j = client.post(url("/halt/clear"), json={}).json()
    assert j["cleared"] is False and "not readable" in j["readError"]
    assert (ws.root / "runtime" / "pipeline-halt.json").read_text() == "{oops"
    ws.write_json("runtime/pipeline-halt.json", {"halted": False, "reason": "x"})
    assert client.post(url("/halt/clear"), json={}).json() == {"ok": True, "cleared": False}
    assert (ws.root / "runtime" / "pipeline-halt.json").exists()
    assert lines(ws.root / "logs" / "errors.jsonl") == []


def test_clear_halt_requires_json_and_accepts_an_empty_body(plugin, ws, client):
    put_halt(ws)
    assert client.post(url("/halt/clear"), content=b"{}", headers={"content-type": "text/plain"}).status_code == 415
    assert client.post(url("/halt/clear"), data={"a": "b"}).status_code == 415
    assert (ws.root / "runtime" / "pipeline-halt.json").exists()
    assert client.post(url("/halt/clear"), content=b"", headers={"content-type": "application/json"}).json()["cleared"] is True


def test_clear_halt_records_the_authenticated_user_id_only(plugin, ws):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    class Session:
        user_id = "u-123"
        email = "operator@example.invalid"
        access_token = "should-never-appear"

    app = FastAPI()

    @app.middleware("http")
    async def gate(request, call_next):
        request.state.session = Session()
        return await call_next(request)

    app.include_router(plugin.router, prefix="/api/plugins/resourcer")
    put_halt(ws)
    r = TestClient(app).post("/api/plugins/resourcer/halt/clear", json={})
    assert r.status_code == 200
    raw = (ws.root / "logs" / "errors.jsonl").read_text()
    assert json.loads(raw)["by"] == "u-123" and "example.invalid" not in raw and "should-never-appear" not in raw


@pytest.mark.skipif(NODE is None or not HALT_LIB.exists(), reason="node or the halt library is not available")
def test_node_halt_library_and_the_plugin_agree(plugin, ws, client):
    env = {**os.environ, "RESOURCER_HOME": str(ws.root)}
    js = ("const h=require(%s);h.setHalt('screening unavailable','HTTP 401',{remedy:'re-login',blockedRun:true});"
          "process.stdout.write(JSON.stringify(h.getHalt()))" % json.dumps(str(HALT_LIB)))
    out = subprocess.run([NODE, "-e", js], capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stderr
    written = json.loads(out.stdout)
    seen = client.get(url("/halt")).json()
    assert seen["halted"] is True and seen["reason"] == "screening unavailable" and seen["detail"] == "HTTP 401"
    assert seen["remedy"] == "re-login" and seen["blockedRuns"] == written["blockedRuns"] == 1
    assert client.post(url("/halt/clear"), json={}).json()["cleared"] is True
    js2 = "const h=require(%s);process.stdout.write(JSON.stringify(h.getHalt()))" % json.dumps(str(HALT_LIB))
    out2 = subprocess.run([NODE, "-e", js2], capture_output=True, text=True, env=env, timeout=60)
    assert out2.stdout.strip() == "null"
    node_errs = [e for e in lines(ws.root / "logs" / "errors.jsonl")]
    assert [e["context"] for e in node_errs] == ["pipeline_halted", "pipeline_resumed"]
    assert node_errs[1]["severity"] == "info"
    node_style = "Pipeline resumed " + chr(0x2014) + " screening unavailable cleared"
    assert node_errs[1]["error"] == node_style
    alerts = lines(ws.root / "outbox" / "alerts.jsonl")
    assert [a["meta"]["event"] for a in alerts] == ["halted", "resumed"] and all(a["key"] == "pipeline-halt" for a in alerts)


# --------------------------------------------------------------- errors feed


PII_LINE = {"ts": None, "context": "zoho_push", "error": "Duplicate for Zed Testerson zed@example.invalid phone 07700 900123",
            "name": "Zed Testerson", "candidateId": "998877", "zohoId": "z-1", "jobTitle": "Sous Chef", "location": "YO2"}


def write_errors(ws, entries):
    ws.write_text("logs/errors.jsonl", "\n".join(json.dumps(e) for e in entries) + "\n")


def test_errors_feed_is_redacted_and_newest_first(plugin, ws, client):
    write_errors(ws, [
        {"ts": ago(hours=3), "context": "cv_download", "error": "timeout", "severity": "warn"},
        {**PII_LINE, "ts": ago(hours=2)},
        {"ts": ago(hours=1), "context": "pipeline_halted", "severity": "critical", "error": "PIPELINE HALTED", "detail": "HTTP 401", "remedy": "secret-looking remedy text"},
    ])
    r = client.get(url("/errors"))
    assert r.status_code == 200
    j = r.json()
    assert [e["context"] for e in j["errors"]] == ["pipeline_halted", "zoho_push", "cv_download"]
    text = r.text
    for leak in ("Zed Testerson", "example.invalid", "998877", "900123", "z-1"):
        assert leak not in text, leak
    zoho = j["errors"][1]
    assert "[email]" in zoho["error"] and "[number]" in zoho["error"] and zoho["jobTitle"] == "Sous Chef" and "name" not in zoho
    assert j["unread"] == 3 and j["acknowledgedAt"] is None


def test_errors_feed_shows_names_only_when_enabled(plugin, ws, client):
    write_errors(ws, [{**PII_LINE, "ts": ago(hours=1)}])
    ws.write_json("config/dashboard-settings.json", {"show_candidate_names": True})
    j = client.get(url("/errors")).json()
    assert j["errors"][0]["name"] == "Zed Testerson"
    assert "998877" not in json.dumps(j) and "example.invalid" not in json.dumps(j)


def test_ack_marks_older_entries_read_atomically(plugin, ws, client):
    write_errors(ws, [{"ts": ago(hours=2), "context": "cv_download", "error": "a"}, {"ts": ago(hours=1), "context": "cv_download", "error": "b"}])
    ack = client.post(url("/errors/ack"), json={})
    assert ack.status_code == 200 and ack.json()["ok"] is True
    stamp = ack.json()["acknowledgedAt"]
    saved = json.loads((ws.root / "logs" / "errors-acknowledged.json").read_text())
    assert saved == {"acknowledgedAt": stamp}
    assert sorted(os.listdir(ws.root / "logs")) == ["errors-acknowledged.json", "errors.jsonl"]
    j = client.get(url("/errors")).json()
    assert j["acknowledgedAt"] == stamp and j["unread"] == 0 and all(e["read"] for e in j["errors"])
    with open(ws.root / "logs" / "errors.jsonl", "a") as fh:
        fh.write(json.dumps({"ts": "2999-01-01T00:00:00.000Z", "context": "zoho_push", "error": "new"}) + "\n")
    j = client.get(url("/errors")).json()
    assert j["unread"] == 1 and j["errors"][0]["read"] is False


def test_ack_requires_json(plugin, ws, client):
    assert client.post(url("/errors/ack"), content=b"{}", headers={"content-type": "text/plain"}).status_code == 415
    assert not (ws.root / "logs" / "errors-acknowledged.json").exists()


def test_errors_feed_reads_only_the_tail_of_a_large_log(plugin, ws, client):
    body = "\n".join(json.dumps({"ts": ago(minutes=5000 - i), "context": "cv_download", "error": "e%d %s" % (i, "x" * 60)}) for i in range(4000)) + "\n"
    ws.write_text("logs/errors.jsonl", body)
    assert (ws.root / "logs" / "errors.jsonl").stat().st_size > 262144
    j = client.get(url("/errors"), params={"limit": 5}).json()
    assert len(j["errors"]) == 5 and j["errors"][0]["error"].startswith("e3999 ")


def test_errors_feed_with_no_log_is_empty(plugin, ws, client):
    assert client.get(url("/errors")).json() == {"errors": [], "acknowledgedAt": None, "unread": 0}


def test_errors_feed_skips_garbage_lines_and_bom(plugin, ws, client):
    ws.write_text("logs/errors.jsonl", chr(0xFEFF) + json.dumps({"ts": ago(minutes=3), "context": "a", "error": "first"}) + "\nnot json\n[1,2]\n" +
                  json.dumps({"ts": ago(minutes=1), "context": "b", "error": "second"}) + "\n")
    j = client.get(url("/errors")).json()
    assert [e["context"] for e in j["errors"]] == ["b", "a"]
