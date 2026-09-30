"""Path jail: '..', absolute paths, symlink escapes and secret-looking names are refused; read-only DB access."""
import hashlib
import os
import sqlite3
import threading

import pytest

from conftest import url

BAD_PATHS = [
    "../x", "runs/../../x", "/etc/passwd", "..", "./..", "runs/./../..", "a/../..", "C:foo", "D:/x",
]


@pytest.mark.parametrize("bad", BAD_PATHS)
def test_rejects_escape_attempts(plugin, ws, bad):
    with pytest.raises(plugin.JailError):
        plugin.jail_path(bad)


def test_rejects_backslash_forms(plugin, ws):
    for bad in (chr(92) + "windows", "runs" + chr(92) + ".." + chr(92) + ".." + chr(92) + "x", "C:" + chr(92) + "x"):
        with pytest.raises(plugin.JailError):
            plugin.jail_path(bad)


def test_rejects_multi_part_forms(plugin, ws):
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs", "..", "..", "x")
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs", "/abs")
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs", "a\x00b")


def test_plain_paths_resolve_inside_home(plugin, ws):
    root = ws.root.resolve()
    assert plugin.jail_path() == root
    assert plugin.jail_path("runs") == root / "runs"
    assert plugin.jail_path("runs", "phase1-x.json") == root / "runs" / "phase1-x.json"
    assert plugin.jail_path("runs/phase1-x.json") == root / "runs" / "phase1-x.json"
    assert plugin.jail_path("does", "not", "exist.json") == root / "does" / "not" / "exist.json"


def test_symlinked_directory_escape_is_rejected(plugin, ws, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.json").write_text("{}")
    (ws.root / "runs").rmdir()
    os.symlink(outside, ws.root / "runs")
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs")
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs", "secret.json")
    assert plugin.read_json("runs", "secret.json", default="fallback") == "fallback"


def test_symlinked_file_escape_is_rejected(plugin, ws, tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text('{"halted": true}')
    os.symlink(outside, ws.root / "runtime" / "pipeline-halt.json")
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runtime", "pipeline-halt.json")
    assert plugin.read_halt() == {"halted": False, "readError": "runtime/pipeline-halt.json is not readable"}


def test_symlink_that_stays_inside_is_allowed(plugin, ws):
    os.symlink(ws.root / "runs", ws.root / "runs-alias")
    assert plugin.jail_path("runs-alias", "x.json") == ws.root.resolve() / "runs" / "x.json"


def test_symlink_into_secrets_dir_is_denied(plugin, ws):
    (ws.root / "secrets").mkdir()
    os.symlink(ws.root / "secrets", ws.root / "runs-alias")
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs-alias", "x.json")


@pytest.mark.parametrize("name", [
    ".env", ".env.local", "auth.json", "state.db", "caterer-credentials.json", "zoho-credentials.json",
    "reed-credentials.json", "caterer-session.json", "reed-session.json", "id_rsa", "server.pem", "api.key",
])
def test_secret_looking_names_are_denied(plugin, ws, name):
    with pytest.raises(plugin.JailError):
        plugin.jail_path(name)
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs", name)


@pytest.mark.parametrize("folder", ["secrets", "state", ".ssh", ".git", "SECRETS"])
def test_secret_directories_are_denied(plugin, ws, folder):
    with pytest.raises(plugin.JailError):
        plugin.jail_path(folder)
    with pytest.raises(plugin.JailError):
        plugin.jail_path("runs", folder, "x")
    with pytest.raises(plugin.JailError):
        plugin.jail_path(folder, "x.json")


def test_files_the_plugin_reads_are_not_denied(plugin, ws):
    for parts in (("candidates.db",), ("credits-sync.json",), ("runtime", "pipeline-halt.json"), ("runtime", "caterer-status.json"),
                  ("logs", "watchdog-runner.jsonl"), ("outbox", "alerts.jsonl"), ("logs", "errors.jsonl"),
                  ("config", "dashboard-settings.json"), ("reed-auth-failed.marker",)):
        plugin.jail_path(*parts)


def test_home_resolution_order(plugin, ws, monkeypatch, tmp_path):
    assert plugin.get_home() == ws.root
    monkeypatch.delenv("RESOURCER_HOME")
    monkeypatch.setattr(plugin, "_CONFIG_HOME", "/from/config")
    assert str(plugin.get_home()) == "/from/config"
    monkeypatch.setattr(plugin, "_CONFIG_HOME", None)
    assert str(plugin.get_home()) == plugin.DEFAULT_HOME
    assert plugin.DEFAULT_HOME == "/opt/data/profiles/resourcer/workspace/resourcer"


def test_profile_query_cannot_move_the_jail(plugin, ws, client, tmp_path):
    other = tmp_path / "other-profile"
    (other / "runs").mkdir(parents=True)
    r = client.get(url("/health"), params={"profile": str(other)})
    assert r.status_code == 200
    assert r.json()["home"] == str(ws.root)


def test_status_never_reads_through_an_escaping_runs_symlink(plugin, ws, client, tmp_path):
    outside = tmp_path / "outside-runs"
    outside.mkdir()
    (outside / "phase1-2099-01-01-0000.json").write_text(
        '{"status":"phase1_running","jobTitle":"Leaked Role","location":"ZZ1","updatedAt":"2099-01-01T00:00:00Z"}')
    (ws.root / "runs").rmdir()
    os.symlink(outside, ws.root / "runs")
    r = client.get(url("/status"))
    assert r.status_code == 200
    assert r.json()["activeRuns"] == []
    assert "Leaked Role" not in r.text


def test_search_refuses_to_write_through_an_escaping_pending_symlink(plugin, ws, client, tmp_path):
    outside = tmp_path / "outside-pending"
    outside.mkdir()
    (ws.root / "pending-searches").rmdir()
    os.symlink(outside, ws.root / "pending-searches")
    r = client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "YO2"})
    assert r.status_code == 400
    assert r.json()["error"] == "path_jail"
    assert list(outside.iterdir()) == []


# --------------------------------------------------------------- read-only database


def test_ro_connect_refuses_writes(plugin, ws, db):
    con = plugin.ro_connect()
    try:
        with pytest.raises(sqlite3.OperationalError):
            con.execute("INSERT INTO territory_searches (job_title, location) VALUES ('x', 'y')")
        with pytest.raises(sqlite3.OperationalError):
            con.execute("CREATE TABLE evil (a)")
        assert con.execute("PRAGMA query_only").fetchone()[0] == 1
    finally:
        con.close()


def _hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("wal", [False, True])
def test_get_routes_leave_the_database_untouched(plugin, ws, client, wal):
    ws.make_db(wal=wal)
    ws.seed_standard()
    before = _hash(ws.db_path)
    for path in ("/health", "/status", "/stats", "/runs", "/territories", "/schedule", "/errors", "/halt"):
        assert client.get(url(path)).status_code == 200, path
    assert _hash(ws.db_path) == before
    con = ws.connect()
    assert con.execute("SELECT COUNT(*) FROM territory_searches").fetchone()[0] == 6
    con.close()
    assert not (ws.root / "candidates.db-journal").exists()


def test_post_routes_never_open_the_database_for_writing(plugin, ws, client, db):
    before = _hash(ws.db_path)
    assert client.post(url("/search"), json={"jobTitle": "Sous Chef", "location": "LS9"}).status_code == 200
    assert client.post(url("/halt/clear"), json={}).status_code == 200
    assert client.post(url("/errors/ack"), json={}).status_code == 200
    assert _hash(ws.db_path) == before


def test_locked_database_gives_503_with_retry_after(plugin, ws, client, db, monkeypatch):
    monkeypatch.setattr(plugin, "DB_BUSY_SECS", 0.2)
    writer = sqlite3.connect(str(ws.db_path), isolation_level=None)
    writer.execute("BEGIN EXCLUSIVE")
    try:
        for path in ("/stats", "/runs", "/territories", "/schedule"):
            r = client.get(url(path))
            assert r.status_code == 503, path
            assert r.json()["error"] == "db_unavailable"
            assert r.headers["retry-after"] == "5"
            assert isinstance(r.json()["detail"], str)
        status = client.get(url("/status"))
        assert status.status_code == 200
        assert status.json()["db"]["ok"] is False
    finally:
        writer.execute("ROLLBACK")
        writer.close()
    assert client.get(url("/stats")).status_code == 200


def test_missing_database_gives_503_not_500(plugin, ws, client):
    r = client.get(url("/stats"))
    assert r.status_code == 503
    assert r.json()["error"] == "db_unavailable"
    health = client.get(url("/health"))
    assert health.status_code == 200 and health.json()["ok"] is False


def test_concurrent_reads_while_a_writer_commits(plugin, ws, client, db):
    stop = threading.Event()
    failures = []

    def writer():
        con = sqlite3.connect(str(ws.db_path), timeout=5)
        i = 0
        while not stop.is_set() and i < 40:
            i += 1
            try:
                con.execute("UPDATE territory_searches SET errors = ? WHERE id = 1", (i,))
                con.commit()
            except sqlite3.OperationalError:
                pass
        con.close()

    t = threading.Thread(target=writer)
    t.start()
    try:
        for _ in range(25):
            r = client.get(url("/stats"))
            if r.status_code not in (200, 503):
                failures.append(r.status_code)
    finally:
        stop.set()
        t.join()
    assert failures == []


def test_a_machine_level_home_is_refused(plugin, tmp_path, monkeypatch, client):
    data = tmp_path / "data"
    (data / "profiles" / "resourcer" / "workspace").mkdir(parents=True)
    (data / "profiles" / "other" / "workspace" / "x").mkdir(parents=True)
    (data / "profiles" / "other" / "workspace" / "x" / "notes.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("RESOURCER_HOME", str(data))
    with pytest.raises(plugin.JailError):
        plugin.jail_path("profiles", "other", "workspace", "x", "notes.json")
    assert plugin.read_json("profiles", "other", "workspace", "x", "notes.json", default="unreadable") == "unreadable"
    for shallow in ("/", "/opt"):
        monkeypatch.setenv("RESOURCER_HOME", shallow)
        with pytest.raises(plugin.JailError):
            plugin.jail_path("etc")


def test_health_reports_a_machine_level_home_instead_of_failing(plugin, tmp_path, monkeypatch, client):
    data = tmp_path / "data"
    (data / "plugins").mkdir(parents=True)
    monkeypatch.setenv("RESOURCER_HOME", str(data))
    r = client.get(url("/health"))
    assert r.status_code == 200 and r.json()["ok"] is False and "machine-level" in r.json()["error"]


def test_a_normal_workspace_is_still_accepted(plugin, ws):
    assert plugin.jail_path() == ws.root.resolve()
