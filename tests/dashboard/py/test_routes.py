"""Read routes against a synthetic workspace: health, stats, runs, territories, schedule."""
import json
from datetime import date, datetime, timedelta, timezone

import pytest

from conftest import iso, url


def today_str():
    return datetime.now(timezone.utc).date().isoformat()


# --------------------------------------------------------------- health


def test_health_reports_every_check(plugin, ws, client, db):
    (ws.root / "config" / "dashboard-settings.json").write_text("{}")
    r = client.get(url("/health"))
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True and j["plugin"] == "resourcer" and j["home"] == str(ws.root)
    c = j["checks"]
    assert c["homeExists"] and c["dbFile"] and c["dbOpen"] and c["runResultsTable"]
    assert {"candidates", "territory_searches", "run_results", "reed_daily_usage"} <= set(c["dbTables"])
    assert c["runsDirReadable"] and c["logsDirReadable"] and c["runtimeDirReadable"]
    assert c["pendingDirExists"] and c["pendingDirWritable"] and c["settingsFile"]
    assert j["sqliteVersion"] and j["python"] and j["version"]


def test_health_never_raises_on_an_empty_home(plugin, tmp_path, monkeypatch, client):
    monkeypatch.setenv("RESOURCER_HOME", str(tmp_path / "missing"))
    r = client.get(url("/health"))
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is False and j["checks"]["homeExists"] is False and j["checks"]["dbOpen"] is False


def test_health_without_run_results_table(plugin, ws, client):
    ws.make_db(run_results=False)
    j = client.get(url("/health")).json()
    assert j["ok"] is True and j["checks"]["runResultsTable"] is False


# --------------------------------------------------------------- stats


def test_stats_numbers_match_the_synthetic_database(plugin, ws, client, db):
    expiry = datetime.now(timezone.utc).date() + timedelta(days=100)
    ws.write_json("config/dashboard-settings.json", {"caterer_expiry": expiry.isoformat()})
    r = client.get(url("/stats"))
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["today"] == db["today"]
    assert (s["zoho"]["caterer"], s["zoho"]["reed"], s["zoho"]["total"]) == (2, 1, 3)
    assert (s["zoho"]["unlockedCaterer"], s["zoho"]["unlockedReed"]) == (2, 0)
    assert s["zoho"]["goal"] == 100000 and s["zoho"]["percent"] == 0.0
    assert s["zoho"]["daysToExpiry"] == 100 and s["zoho"]["perDayNeeded"] == 1000
    q = s["quota"]
    assert q["source"] == "run_results"
    assert (q["todayNew"], q["todayUnlocked"], q["todayDuplicates"], q["todayErrors"], q["todayRuns"]) == (15, 18, 3, 1, 2)
    assert (q["weekNew"], q["weekUnlocked"], q["weekRuns"]) == (22, 26, 3)
    assert q["burnPerDay"] == 3
    assert len(q["series"]) == 14 and q["series"][-1]["date"] == db["today"]
    by_date = {d["date"]: d for d in q["series"]}
    assert by_date[db["today"]] == {"date": db["today"], "new": 15, "unlocked": 18, "runs": 2}
    assert by_date[db["yesterday"]]["unlocked"] == 8
    zero_days = [d for d in q["series"] if d["runs"] == 0]
    assert len(zero_days) == 11 and all(d["new"] == 0 and d["unlocked"] == 0 for d in zero_days)
    assert s["targets"]["perDay"] == 181 and s["targets"]["perWeek"] == 1269
    assert (s["targets"]["todayPulled"], s["targets"]["weekPulled"]) == (18, 26)
    assert s["targets"]["todayPercent"] == round(18 * 100 / 181, 1) and s["targets"]["weekPercent"] == round(26 * 100 / 1269, 1)
    assert s["territories"] == {"total": 5, "due": 3, "overdue": 1, "high": 1, "medium": 1, "low": 3}
    assert s["reed"]["profileViews"] == 71 and s["reed"]["dailyLimit"] == 600 and s["reed"]["remaining"] == 529
    assert s["linkedToZohoToday"] == 2
    assert s["credits"]["source"] == "default" and s["credits"]["remaining"] == 62475 and s["credits"]["expiry"] == expiry.isoformat()
    assert s["warnings"] == []


def test_stats_credits_prefer_the_sync_file(plugin, ws, client, db):
    ws.write_json("credits-sync.json", {"credits": 44463, "syncedAt": "2026-09-29T08:00:00.000Z", "source": "test"})
    c = client.get(url("/stats")).json()["credits"]
    assert (c["remaining"], c["source"], c["syncedAt"]) == (44463, "sync", "2026-09-29T08:00:00.000Z")
    assert c["percentUsed"] == round((62475 - 44463) * 100 / 62475)
    expect = (date.fromisoformat(db["today"]) + timedelta(days=44463 // 3)).isoformat()
    assert c["projectedRunout"] == expect and c["burnPerDay"] == 3
    ws.write_json("credits-sync.json", {"credits": 0})
    assert client.get(url("/stats")).json()["credits"]["source"] == "default"
    ws.write_text("credits-sync.json", "{broken")
    assert client.get(url("/stats")).json()["credits"]["source"] == "default"


@pytest.mark.parametrize("raw", ['{"credits": Infinity}', '{"credits": NaN}', '{"credits": 1e999}', '{"credits": "44463"}', '{"credits": true}'])
def test_stats_ignore_non_finite_or_odd_credit_values(plugin, ws, client, db, raw):
    ws.write_text("credits-sync.json", raw)
    r = client.get(url("/stats"))
    assert r.status_code == 200 and r.json()["credits"]["source"] == "default"


def test_stats_projected_runout_never_overflows(plugin, ws, client, db):
    ws.write_json("credits-sync.json", {"credits": 10 ** 15})
    con = ws.connect()
    con.execute("UPDATE run_results SET new_to_zoho = 7 WHERE run_key = 'merged-queue-a'")
    con.commit()
    con.close()
    c = client.get(url("/stats")).json()["credits"]
    assert c["remaining"] == 10 ** 15 and c["projectedRunout"] is None


def test_stats_credits_fall_back_to_the_territory_table(plugin, ws, client, db):
    con = ws.connect()
    con.execute("UPDATE territory_searches SET credits_remaining = 5000, last_searched = '2026-09-01' WHERE id = 1")
    con.execute("UPDATE territory_searches SET credits_remaining = 4000, last_searched = '2099-01-01' WHERE id = 2")
    con.commit()
    con.close()
    c = client.get(url("/stats")).json()["credits"]
    assert (c["remaining"], c["source"]) == (4000, "db")


def test_stats_read_bom_and_ignore_unrelated_files(plugin, ws, client, db):
    (ws.root / "credits-sync.json").write_bytes(b"\xef\xbb\xbf" + json.dumps({"credits": 123}).encode())
    assert client.get(url("/stats")).json()["credits"]["remaining"] == 123


def test_stats_without_run_results_uses_the_db_fallback(plugin, ws, client):
    ws.make_db(run_results=False)
    ws.seed_standard(runs_table=False)
    r = client.get(url("/stats"))
    assert r.status_code == 200
    s = r.json()
    q = s["quota"]
    assert q["source"] == "db-fallback" and q["todayNew"] == 2 and q["todayUnlocked"] is None and q["series"] == []
    assert q["weekNew"] == 3
    assert s["targets"]["todayPulled"] is None and s["targets"]["todayPercent"] is None
    assert any("run_results" in w for w in s["warnings"])
    assert s["zoho"]["total"] == 3


def test_stats_with_an_incomplete_run_results_table_falls_back(plugin, ws, client):
    ws.make_db(run_results=False)
    con = ws.connect()
    con.execute("CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT)")
    con.commit()
    con.close()
    r = client.get(url("/stats"))
    assert r.status_code == 200 and r.json()["quota"]["source"] == "db-fallback"


def test_stats_tolerates_a_database_without_optional_tables(plugin, ws, client):
    con = ws.connect()
    con.executescript("CREATE TABLE candidates (id INTEGER PRIMARY KEY, zoho_id TEXT, unlocked INTEGER);"
                      "CREATE TABLE territory_searches (id INTEGER PRIMARY KEY, enabled INTEGER, next_run_date TEXT, priority TEXT);")
    con.execute("INSERT INTO candidates (zoho_id, unlocked) VALUES ('z', 1)")
    con.commit()
    con.close()
    r = client.get(url("/stats"))
    assert r.status_code == 200
    s = r.json()
    assert s["zoho"]["caterer"] == 1 and s["zoho"]["reed"] == 0
    assert s["reed"]["profileViews"] == 0 and s["reed"]["dailyLimit"] == 600
    assert any("reed_daily_usage" in w for w in s["warnings"])


def test_stats_settings_change_targets_and_goal(plugin, ws, client, db):
    ws.write_json("config/dashboard-settings.json", {"zoho_goal": 50000, "target_per_day": 100, "target_per_week": 700,
                                                     "caterer_expiry": "2027-01-01", "reed_daily_limit": 300})
    s = client.get(url("/stats")).json()
    assert s["zoho"]["goal"] == 50000 and s["targets"]["perDay"] == 100 and s["targets"]["perWeek"] == 700
    assert s["credits"]["expiry"] == "2027-01-01" and s["targets"]["todayPercent"] == 18.0
    ws.write_json("config/dashboard-settings.json", {"zoho_goal": "lots", "target_per_day": -5, "caterer_expiry": "soon"})
    s = client.get(url("/stats")).json()
    assert s["zoho"]["goal"] == 100000 and s["targets"]["perDay"] == 181 and s["credits"]["expiry"] == "2027-03-11"


def test_profile_query_parameter_is_ignored(plugin, ws, client, db):
    a = client.get(url("/stats")).json()
    b = client.get(url("/stats"), params={"profile": "other"}).json()
    a.pop("generatedAt"), b.pop("generatedAt")
    assert a == b


# --------------------------------------------------------------- runs


RUN_KEYS = {"runKey", "date", "startedAt", "completedAt", "phase1StartedAt", "jobTitle", "location", "distance", "keywords", "sources",
            "pool", "downloaded", "newToZoho", "duplicates", "skipped", "errors", "approvedP1", "skippedDb", "skippedReview",
            "pagesScraped", "runSecs", "screeningModel", "caterer", "reed", "reedAuthFailed"}


def test_runs_are_newest_first_with_parsed_breakdowns(plugin, ws, client, db):
    j = client.get(url("/runs")).json()
    assert j["total"] == 5 and j["limit"] == 20 and j["offset"] == 0
    assert [r["runKey"] for r in j["runs"]] == ["merged-queue-b", "merged-queue-a", "merged-queue-c", "merged-queue-d", "merged-queue-e"]
    a = j["runs"][1]
    assert set(a) == RUN_KEYS
    assert a["runSecs"] == 360 and j["runs"][0]["runSecs"] == 300
    assert a["caterer"]["pool"] == 8 and a["caterer"]["phase1"]["approved"] == 4 and a["caterer"]["phase1"]["pagesScraped"] == 2
    assert a["reed"]["authFailed"] is False and a["reedAuthFailed"] is False
    assert j["runs"][0]["reed"] is None
    assert j["runs"][3]["reedAuthFailed"] is True and j["runs"][3]["reed"]["authFailureReason"] == "token refresh failed"
    assert a["screeningModel"] == "test-model" and a["newToZoho"] == 10 and a["downloaded"] == 12


def test_runs_show_a_failed_reed_attempt_as_failed_never_as_ok_pool_0(plugin, ws, client, db):
    """docs/parity/reed-first-page.md: a Reed attempt that could not search is 'failed' with errors 1 in its breakdown; old rows are unchanged."""
    failed = json.dumps({"pool": 0, "newToZoho": 0, "downloaded": 0, "duplicates": 0, "errors": 1, "status": "failed", "failed": True,
                         "failureReason": "HTTP 400 code 50010", "authFailed": False, "authFailureReason": None, "phase1": {"pagesScraped": 0}})
    empty = json.dumps({"pool": 0, "newToZoho": 0, "downloaded": 0, "duplicates": 0, "errors": 0, "status": "empty", "authFailed": False, "phase1": {}})
    con = ws.connect()
    for key, rj in (("merged-queue-f", failed), ("merged-queue-g", empty)):
        con.execute("INSERT INTO run_results (run_key, date, started_at, completed_at, job_title, location, distance, keywords, sources, errors, reed_json) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)", (key, today_str(), "2099-01-01T10:00:00.000Z", "2099-01-01T10:05:00.000Z", "Sous Chef", "LS1", 20, "", "both", 0, rj))
    con.commit()
    con.close()
    runs = {r["runKey"]: r for r in client.get(url("/runs"), params={"limit": 50}).json()["runs"]}
    f, g, old = runs["merged-queue-f"], runs["merged-queue-g"], runs["merged-queue-a"]
    assert f["reed"]["failed"] is True and f["reed"]["status"] == "failed" and f["reed"]["errors"] == 1
    assert f["reed"]["failureReason"] == "HTTP 400 code 50010" and f["reed"]["pool"] == 0
    assert g["reed"]["status"] == "empty" and "failed" not in g["reed"]
    assert "status" not in old["reed"] and "failed" not in old["reed"]
    assert set(f) == RUN_KEYS


def test_runs_paging_and_clamping(plugin, ws, client, db):
    page = client.get(url("/runs"), params={"limit": 2, "offset": 2}).json()
    assert [r["runKey"] for r in page["runs"]] == ["merged-queue-c", "merged-queue-d"] and page["total"] == 5
    assert client.get(url("/runs"), params={"limit": 100000}).json()["limit"] == 100
    assert client.get(url("/runs"), params={"limit": 0}).json()["limit"] == 1
    assert client.get(url("/runs"), params={"limit": "abc", "offset": "-4"}).json()["offset"] == 0


def test_runs_without_the_table_are_empty_with_a_warning(plugin, ws, client):
    ws.make_db(run_results=False)
    j = client.get(url("/runs")).json()
    assert j["total"] == 0 and j["runs"] == [] and j["warnings"]


def test_runs_ignore_unexpected_keys_inside_breakdown_json(plugin, ws, client, db):
    con = ws.connect()
    con.execute("UPDATE run_results SET caterer_json = ? WHERE run_key = 'merged-queue-a'", (json.dumps(
        {"pool": 1, "name": "Zed Testerson", "candidates": [{"name": "Zed Testerson", "email": "zed@example.invalid"}], "phase1": {"secret": "x"}}),))
    con.commit()
    con.close()
    text = client.get(url("/runs")).text
    assert "Zed Testerson" not in text and "example.invalid" not in text and '"secret"' not in text


# --------------------------------------------------------------- territories


TERR_KEYS = {"id", "jobTitle", "location", "distance", "keywords", "priority", "enabled", "sources", "pool", "newToZoho", "duplicates",
             "skipped", "errors", "lastSearched", "nextRunDate", "isDue", "daysUntilDue"}


def ids(resp):
    return [r["id"] for r in resp.json()["rows"]]


def test_territories_default_listing_orders_due_first(plugin, ws, client, db):
    r = client.get(url("/territories"))
    j = r.json()
    assert j["total"] == 5 and j["today"] == db["today"] and ids(r) == [4, 1, 2, 3, 6]
    assert all(set(row) == TERR_KEYS for row in j["rows"])
    by_id = {row["id"]: row for row in j["rows"]}
    assert by_id[1]["daysUntilDue"] == -1 and by_id[2]["daysUntilDue"] == 0 and by_id[3]["daysUntilDue"] == 3 and by_id[4]["daysUntilDue"] == 0
    assert [by_id[i]["isDue"] for i in (1, 2, 3, 4, 6)] == [True, True, False, True, False]
    assert by_id[4]["sources"] == "caterer" and by_id[4]["nextRunDate"] is None and by_id[3]["keywords"] == "dbs"
    assert by_id[2]["enabled"] is True


@pytest.mark.parametrize("params, expected", [
    ({"q": "sous"}, [4, 1, 6]),
    ({"q": "SOUS chef", "exact": "1"}, [4, 1]),
    ({"q": "%"}, [6]),
    ({"q": "_"}, []),
    ({"q": "50%"}, [6]),
    ({"loc": "yo"}, [4, 1]),
    ({"priority": "high"}, [2]),
    ({"due": "1"}, [4, 1, 2]),
    ({"enabled": "0"}, [4, 1, 5, 2, 3, 6]),
    ({"q": "chef", "loc": "ls"}, [2]),
    ({"limit": 2, "offset": 2}, [2, 3]),
])
def test_territory_filters(plugin, ws, client, db, params, expected):
    assert ids(client.get(url("/territories"), params=params)) == expected


def test_territory_filter_validation_and_clamping(plugin, ws, client, db):
    assert client.get(url("/territories"), params={"priority": "bogus"}).status_code == 400
    j = client.get(url("/territories"), params={"limit": 999999}).json()
    assert j["limit"] == 100
    assert client.get(url("/territories"), params={"q": "x" * 500}).status_code == 200
    r = client.get(url("/territories"), params={"q": "' OR 1=1 --"})
    assert r.status_code == 200 and r.json()["rows"] == []
    assert client.get(url("/territories"), params={"q": "x'; DROP TABLE territory_searches; --"}).status_code == 200
    assert client.get(url("/territories")).json()["total"] == 5


def test_territories_survive_a_database_without_sources_column(plugin, ws, client):
    con = ws.connect()
    con.executescript("CREATE TABLE territory_searches (id INTEGER PRIMARY KEY, job_title TEXT, location TEXT, distance INTEGER, "
                      "keywords TEXT, priority TEXT, enabled INTEGER, candidate_count INTEGER, new_to_zoho INTEGER, duplicates INTEGER, "
                      "skipped INTEGER, errors INTEGER, last_searched TEXT, next_run_date TEXT);")
    con.execute("INSERT INTO territory_searches (job_title, location, priority, enabled) VALUES ('Chef', 'M1', 'low', 1)")
    con.commit()
    con.close()
    j = client.get(url("/territories")).json()
    assert j["total"] == 1 and j["rows"][0]["sources"] == "caterer"


# --------------------------------------------------------------- schedule


def test_schedule_groups_and_counts(plugin, ws, client, db):
    j = client.get(url("/schedule")).json()
    assert j["today"] == db["today"] and j["totalEnabled"] == 5 and j["totalDue"] == 3 and j["capPerDay"] == 57
    keys = [g["key"] for g in j["groups"]]
    plus3 = (date.fromisoformat(db["today"]) + timedelta(days=3)).isoformat()
    plus5 = (date.fromisoformat(db["today"]) + timedelta(days=5)).isoformat()
    assert keys == ["overdue", db["today"], plus3, plus5, "unscheduled"]
    labels = {g["key"]: g["label"] for g in j["groups"]}
    assert labels["overdue"] == "Overdue" and labels[db["today"]] == "Due today" and labels["unscheduled"] == "Unscheduled"
    assert [g["count"] for g in j["groups"]] == [1, 1, 1, 1, 1]
    overdue = j["groups"][0]["rows"][0]
    assert overdue["id"] == 1 and overdue["jobTitle"] == "Sous Chef" and overdue["nextRunDate"] == db["yesterday"]
    assert j["groups"][-1]["rows"][0]["id"] == 4 and j["groups"][-1]["rows"][0]["sources"] == "caterer"
    assert "supervisor" in j["queueCheck"] and "06:00-22:00" in j["operatingHours"]


def test_schedule_days_and_truncation(plugin, ws, client, db):
    j = client.get(url("/schedule"), params={"days": 1}).json()
    assert [g["key"] for g in j["groups"]] == ["overdue", db["today"], "unscheduled"]
    con = ws.connect()
    for i in range(5):
        con.execute("INSERT INTO territory_searches (job_title, location, priority, enabled, next_run_date, sources) VALUES (?,?,?,?,?,?)",
                    ("Extra %d" % i, "M%d" % i, "low", 1, db["yesterday"], "both"))
    con.commit()
    con.close()
    j = client.get(url("/schedule"), params={"perGroup": 2}).json()
    overdue = j["groups"][0]
    assert overdue["count"] == 6 and len(overdue["rows"]) == 2 and overdue["truncated"] is True
    assert client.get(url("/schedule"), params={"days": 999, "perGroup": 999}).status_code == 200


def test_schedule_uses_settings_for_the_hours_label(plugin, ws, client, db):
    ws.write_json("config/dashboard-settings.json", {"operating_hours": {"start": 7, "end": 20, "tz": "Europe/London"}})
    assert "07:00-20:00 Europe/London" in client.get(url("/schedule")).json()["operatingHours"]
