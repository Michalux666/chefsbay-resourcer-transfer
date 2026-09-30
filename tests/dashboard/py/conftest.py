"""Fixtures for the resourcer dashboard plugin tests. Synthetic data only; nothing touches a real workspace."""
import importlib.util
import json
import os
import sqlite3
import sys

sys.dont_write_bytecode = True  # never leave __pycache__ inside plugin/resourcer, which is copied to the instance
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import pytest
from fastapi import Depends, FastAPI, Query
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[3]
API_FILE = REPO / "plugin" / "resourcer" / "dashboard" / "plugin_api.py"
FIXTURES = REPO / "tests" / "dashboard" / "fixtures"
PREFIX = "/api/plugins/resourcer"
MODULE_NAME = "hermes_dashboard_plugin_resourcer"

SCHEMA = """
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY, caterer_id TEXT UNIQUE, reed_id TEXT UNIQUE, source TEXT DEFAULT 'caterer', role TEXT,
  location TEXT, pulled_date TEXT, unlocked INTEGER DEFAULT 0, zoho_id TEXT, created_at TEXT, zoho_pushed_at TEXT);
CREATE TABLE territory_searches (
  id INTEGER PRIMARY KEY, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT DEFAULT '', active_within TEXT,
  cv_limit TEXT, priority TEXT, enabled INTEGER DEFAULT 1, interval_days INTEGER, candidate_count INTEGER,
  new_to_zoho INTEGER, duplicates INTEGER, skipped INTEGER, errors INTEGER, credits_remaining INTEGER,
  last_searched TEXT, next_run_date TEXT, sources TEXT);
CREATE TABLE reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER, cv_downloads INTEGER, daily_limit INTEGER);
CREATE TABLE run_results (
  run_key TEXT PRIMARY KEY, date TEXT NOT NULL, started_at TEXT, completed_at TEXT, requested_at TEXT,
  phase1_started_at TEXT, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT, sources TEXT, pool INTEGER,
  downloaded INTEGER, new_to_zoho INTEGER, duplicates INTEGER, skipped INTEGER, errors INTEGER, approved_p1 INTEGER,
  skipped_db INTEGER, skipped_review INTEGER, pages_scraped INTEGER, total_runtime_secs INTEGER,
  phase2_runtime_secs INTEGER, credits_remaining INTEGER, screening_model TEXT, caterer_json TEXT, reed_json TEXT,
  created_at TEXT DEFAULT (datetime('now')));
"""


def load_plugin_module():
    """Import plugin_api.py exactly the way the Hermes dashboard does (stand-alone module, registered first)."""
    spec = importlib.util.spec_from_file_location(MODULE_NAME, API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = mod
    spec.loader.exec_module(mod)
    return mod


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)


class Workspace:
    def __init__(self, root: Path):
        self.root = root
        for d in ("runs", "pending-searches", "logs", "runtime", "config", "outbox", "backups"):
            (root / d).mkdir(parents=True, exist_ok=True)
        (root / "config" / "territory-defaults.json").write_text(json.dumps({
            "distance": 20, "activeWithin": "1 month", "cvLimit": 20, "priority": "low", "hideViewed": 7, "sources": "both",
            "priorityDays": {"high": 2, "medium": 3, "low": 7}}), encoding="utf-8")

    def path(self, *parts: str) -> Path:
        return self.root.joinpath(*parts)

    @property
    def db_path(self) -> Path:
        return self.root / "candidates.db"

    def write_json(self, rel: str, obj: Any, mtime_ago_min: Optional[float] = None, now: Optional[datetime] = None) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj), encoding="utf-8")
        if mtime_ago_min is not None:
            ts = ((now or datetime.now(timezone.utc)) - timedelta(minutes=mtime_ago_min)).timestamp()
            os.utime(p, (ts, ts))
        return p

    def write_text(self, rel: str, text: str) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path))

    def make_db(self, run_results: bool = True, wal: bool = False) -> None:
        con = self.connect()
        script = SCHEMA if run_results else SCHEMA.split("CREATE TABLE run_results")[0]
        con.executescript(script)
        if wal:
            con.execute("PRAGMA journal_mode=WAL")
        con.commit()
        con.close()

    def seed_standard(self, runs_table: bool = True) -> Dict[str, str]:
        """Standard synthetic data; dates are relative to the real UTC today."""
        today = datetime.now(timezone.utc).date()
        d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
        con = self.connect()
        rows = [
            (1, "c1", None, "caterer", 1, "z1", d(0) + " 09:00:00"), (2, "c2", None, "caterer", 1, "z2", d(-3) + " 09:00:00"),
            (3, "c3", None, "caterer", 0, None, None), (4, None, "r1", "reed", 0, "z3", d(0) + " 10:00:00"),
            (5, None, "r2", "reed", 0, None, None),
        ]
        for i, cid, rid, src, unlocked, zid, pushed in rows:
            con.execute("INSERT INTO candidates (id, caterer_id, reed_id, source, unlocked, zoho_id, zoho_pushed_at) VALUES (?,?,?,?,?,?,?)",
                        (i, cid, rid, src, unlocked, zid, pushed))
        terr = [
            (1, "Sous Chef", "YO1", 20, "", "low", 1, 12, 3, 0, 0, 0, d(-9), d(-1), "both"),
            (2, "Head Chef", "LS1", 20, "", "high", 1, 20, 5, 1, 0, 0, d(-7), d(0), "caterer"),
            (3, "Kitchen Porter", "M1", 20, "dbs", "medium", 1, 8, 2, 0, 1, 0, d(-4), d(3), "both"),
            (4, "Sous Chef", "YO2", 20, "", "low", 1, None, None, None, None, None, None, None, None),
            (5, "Chef", "EC1A", 20, "", "low", 0, 4, 0, 0, 0, 0, d(-10), d(-1), "reed"),
            (6, "50% Sous", "AB1", 20, "", "low", 1, 1, 0, 0, 0, 0, d(-2), d(5), "both"),
        ]
        for r in terr:
            con.execute("INSERT INTO territory_searches (id, job_title, location, distance, keywords, priority, enabled, "
                        "candidate_count, new_to_zoho, duplicates, skipped, errors, last_searched, next_run_date, sources) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", r)
        con.execute("INSERT INTO reed_daily_usage VALUES (?,?,?,?)", (d(0), 71, 10, 600))
        cat = json.dumps({"pool": 8, "newToZoho": 3, "downloaded": 4, "duplicates": 1, "skipped": 0, "errors": 0,
                          "phase1": {"pagesScraped": 2, "approved": 4, "skippedDb": 5, "skippedReview": 1}})
        reed = json.dumps({"pool": 5, "newToZoho": 2, "downloaded": 2, "duplicates": 0, "errors": 0, "authFailed": False,
                           "phase1": {"pagesScraped": 1, "approved": 2}})
        reed_bad = json.dumps({"pool": 0, "newToZoho": 0, "downloaded": 0, "duplicates": 0, "errors": 1, "authFailed": True,
                               "authFailureReason": "token refresh failed", "phase1": {}})
        base = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(hours=3)
        runs = [
            # run_key, day offset, started, completed, new, downloaded, dup, err, caterer_json, reed_json
            ("merged-queue-a", 0, base, base + timedelta(minutes=6), 10, 12, 2, 0, cat, reed),
            ("merged-queue-b", 0, base + timedelta(hours=1), base + timedelta(hours=1, minutes=5), 5, 6, 1, 1, cat, "{bad json"),
            ("merged-queue-c", -1, base - timedelta(days=1), base - timedelta(days=1) + timedelta(minutes=4), 7, 8, 1, 0, None, None),
            ("merged-queue-d", -10, base - timedelta(days=10), base - timedelta(days=10) + timedelta(minutes=4), 3, 3, 0, 0, None, reed_bad),
            ("merged-queue-e", -20, base - timedelta(days=20), base - timedelta(days=20) + timedelta(minutes=4), 9, 9, 0, 0, None, None),
        ]
        for key, off, started, done, new, dl, dup, err, cj, rj in (runs if runs_table else []):
            con.execute(
                "INSERT INTO run_results (run_key, date, started_at, completed_at, phase1_started_at, job_title, location, distance, "
                "keywords, sources, pool, downloaded, new_to_zoho, duplicates, skipped, errors, approved_p1, skipped_db, "
                "skipped_review, pages_scraped, screening_model, caterer_json, reed_json) VALUES "
                "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (key, d(off), iso(started), iso(done), iso(started), "Sous Chef", "YO1", 20, "", "both", 13, dl, new, dup, 0, err,
                 6, 5, 2, 3, "test-model", cj, rj))
        con.commit()
        con.close()
        return {"today": d(0), "yesterday": d(-1), "in3": d(3)}


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    root = tmp_path / "profile" / "workspace" / "resourcer"
    root.mkdir(parents=True)
    monkeypatch.setenv("RESOURCER_HOME", str(root))
    monkeypatch.delenv("RESOURCER_SOURCES", raising=False)
    monkeypatch.delenv("RESOURCER_ENV_FILE", raising=False)
    return Workspace(root)


@pytest.fixture()
def plugin():
    mod = load_plugin_module()
    yield mod
    sys.modules.pop(MODULE_NAME, None)


def build_app(plugin) -> FastAPI:
    async def scope(profile: Optional[str] = Query(None)):  # what Hermes adds to every plugin route
        return None

    app = FastAPI()
    app.include_router(plugin.router, prefix=PREFIX, dependencies=[Depends(scope)])
    return app


@pytest.fixture()
def client(plugin, ws):
    return TestClient(build_app(plugin))


@pytest.fixture()
def db(ws):
    ws.make_db()
    return ws.seed_standard()


def url(path: str) -> str:
    return PREFIX + path
