"""Resourcer dashboard plugin - backend routes (Hermes dashboard plugin, FastAPI).

Mounted by Hermes at /api/plugins/resourcer/ (prefix = manifest.json "name"). Loader contract:
this file is imported once at dashboard start as a stand-alone module (no relative imports, no sibling
modules), must export a module-level ``router``, and auth is done by the dashboard middleware.

Design rules (docs/DESIGN.md 5.8, docs/parity/dashboard.md):
  * stdlib + fastapi + pydantic only (no PyYAML, nothing pip-installed);
  * every filesystem path goes through jail_path(): it pins the plugin to RESOURCER_HOME and rejects
    absolute paths, '..' segments, symlink escapes and secret-looking names; the one exception is
    reed_source_setting(), which reads the single key RESOURCER_SOURCES from the profile .env behind its own fence;
  * candidates.db is opened read-only (mode=ro + query_only) - this plugin never writes to it;
  * the only writes are: pending-searches/search-*.json (atomic, no-clobber), runtime/pipeline-halt.json
    removal + logs/errors.jsonl + outbox/alerts.jsonl appends (halt clear), logs/errors-acknowledged.json;
  * responses carry no candidate names, emails, phones or ids.
"""
from __future__ import annotations

import errno
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

router = APIRouter()

PLUGIN_NAME = "resourcer"
PLUGIN_VERSION = "1.0.0"
DEFAULT_HOME = "/opt/data/profiles/resourcer/workspace/resourcer"

MAX_BODY_BYTES = 4096
MAX_JSON_FILE_BYTES = 2 * 1024 * 1024
PENDING_PARSE_CAP = 500
ENV_FILE_MAX_BYTES = 64 * 1024
SEARCH_QUEUE_CAP = 25  # manual searches (dashboard or CLI) waiting at once; each one spends paid Caterer credits
MANUAL_SOURCES = ("dashboard", "request-search-cli")
RUN_SCAN_CAP = 300
LIVE_WINDOW_SECS = 2 * 3600
CLAIM_STALE_SECS = 10 * 60
LOCK_STALE_SECS = 30
LOCK_WAIT_SECS = 3.0
DB_BUSY_SECS = 5.0
TERRITORY_DAILY_CAP = 57  # territory-utils.js DAILY_TERRITORY_CAP: the sweep must finish inside the 30-day activity window

DEFAULT_SETTINGS: Dict[str, Any] = {
    "zoho_goal": 100000,
    "caterer_credits_total": 62475,
    "caterer_expiry": "2027-03-11",
    "reed_expiry": "2027-03-18",
    "reed_daily_limit": 600,
    "operating_hours": {"start": 6, "end": 22, "tz": "Europe/London"},
    "target_per_day": 181,
    "target_per_week": 1269,
    "show_candidate_names": False,
    "location_mode": "outward",
    "stall_minutes": 20,
    "backup_stale_hours": 26,
    "disk_warn_pct": 75,
    "disk_critical_pct": 85,
}

# Same table as run-lock.js STATUS_MAX_AGE (minutes); phase1_complete is widened for the Reed stage.
STATUS_MAX_AGE_MIN = {
    "phase1_initializing": 20,
    "phase1_taking_over": 5,
    "phase1_searching": 30,
    "phase1_active": 60,
    "phase1_running": 60,
    "phase1_complete": 10,
    "phase2_starting": 30,
    "phase2_pushing": 30,
}
PHASE1_RUNNING = ("phase1_searching", "phase1_active", "phase1_running")
PHASE2_ACTIVE = ("phase2_starting", "phase2_pushing")

VALID_SOURCES = ("both", "caterer", "reed")
_SOURCES_LINE_RE = re.compile(r"^(?:export\s+)?RESOURCER_SOURCES\s*=\s*(.*)$")
VALID_PRIORITIES = ("high", "medium", "low")
VALID_DISTANCES = (5, 10, 20, 30, 40, 60, 80)
VALID_ACTIVE_WITHIN = ("14 days", "1 month", "2 months", "3 months", "6 months", "12 months", "18 months", "All")
CV_LIMIT_MIN, CV_LIMIT_MAX = 10, 50
ACRONYMS = frozenset(["DBS", "NVQ", "CDP", "HND", "HNC", "UK", "EU", "TV", "CV", "HR", "IT"])
CITY_NAMES = frozenset([
    "london", "manchester", "leeds", "liverpool", "york", "york city", "sheffield", "birmingham",
    "bristol", "nottingham", "leicester", "newcastle", "glasgow", "edinburgh", "cardiff", "brighton",
    "oxford", "cambridge", "reading", "coventry", "hull", "bradford", "wolverhampton", "derby", "stoke",
    "exeter", "portsmouth", "southampton", "norwich", "plymouth", "sunderland", "middlesbrough", "bolton",
    "blackpool",
])

_TITLE_CHARS = re.compile(r"^[A-Za-z0-9 &'./()+-]+$")
_KEYWORD_CHARS = re.compile(r"^[A-Za-z0-9 ,.&'/+:()_-]*$")
_LOCATION_CHARS = re.compile(r"^[A-Za-z0-9 .'-]+$")
_OUTWARD_RE = re.compile(r"^[A-Z]{1,2}[0-9][0-9A-Z]?$")
_POSTCODE_RE = re.compile(r"^([A-Z]{1,2}[0-9][0-9A-Z]?) ?([0-9][A-Z]{2})$")
_PLACE_RE = re.compile(r"^[A-Z][A-Z .'-]{1,38}[A-Z]$")
_KEYWORD_NONE_RE = re.compile(r"^(none|\(none\)|n/a|null|undefined|-)$", re.I)
_KEYWORD_DROP_RE = re.compile(r"^(-?location:[a-z0-9]+|currentlocation:[a-z0-9]+)$", re.I)
_WS_RE = re.compile(r"[ \t\r\n]+")
_KEYWORD_SPLIT_RE = re.compile(r"[ \t\r\n,]+")
_NAME_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?<![\w-])\+?\d(?: ?\d){9,14}(?![\w-])")

_DENY_BASENAME_RE = re.compile(
    r"^(\.env(\..*)?|auth\.json|state\.db|.*credentials.*|.*session.*\.json|.*\.pem|.*\.key|id_rsa.*)$", re.I
)
_DENY_DIRS = frozenset(["secrets", "state", ".ssh", ".git"])


class JailError(ValueError):
    """A path escapes RESOURCER_HOME or names something this plugin must never touch."""


class DbUnavailable(Exception):
    """candidates.db cannot be read right now (missing, locked, hot journal)."""


def _config_home() -> Optional[str]:
    try:
        cfg = Path(__file__).with_name("plugin_config.json")
        data = json.loads(cfg.read_text(encoding="utf-8-sig"))
        value = data.get("resourcerHome")
        return value if isinstance(value, str) and value.startswith("/") else None
    except Exception:
        return None


_CONFIG_HOME = _config_home()


def get_home() -> Path:
    """RESOURCER_HOME env, else plugin_config.json {"resourcerHome"}, else the instance default.

    A root that is really the machine level (too shallow, or holding profiles/ or plugins/) is refused: the jail
    below is only as tight as its root, and a wrong variable must not expose other profiles.
    """
    env = os.environ.get("RESOURCER_HOME")
    home = Path(env or _CONFIG_HOME or DEFAULT_HOME)
    try:
        resolved = home.resolve()
        machine_level = len(resolved.parts) < 3 or (resolved / "profiles").is_dir() or (resolved / "plugins").is_dir()
    except OSError:
        machine_level = False
    if machine_level:
        raise JailError("RESOURCER_HOME points at a machine-level directory, not a resourcer workspace")
    return home


def jail_path(*parts: str) -> Path:
    """Resolve parts under get_home(); the ONLY way this module turns a name into a path."""
    root = get_home().resolve()
    segments: List[str] = []
    for part in parts:
        part = os.fspath(part)
        if "\x00" in part:
            raise JailError("NUL byte in path")
        if part.startswith("/") or part.startswith(chr(92)) or re.match(r"^[A-Za-z]:", part):
            raise JailError("absolute paths are not allowed")
        for seg in part.replace(chr(92), "/").split("/"):
            if seg in ("", "."):
                continue
            if seg == "..":
                raise JailError("'..' segments are not allowed")
            segments.append(seg)
    for seg in segments[:-1]:
        if seg.lower() in _DENY_DIRS:
            raise JailError("path is not accessible")
    if segments and (segments[-1].lower() in _DENY_DIRS or _DENY_BASENAME_RE.match(segments[-1])):
        raise JailError("path is not accessible")
    target = root.joinpath(*segments).resolve()
    try:
        rel = target.relative_to(root)
    except ValueError:
        raise JailError("path escapes the resourcer home")
    if any(p.lower() in _DENY_DIRS for p in rel.parts) or (rel.parts and _DENY_BASENAME_RE.match(rel.parts[-1])):
        raise JailError("path is not accessible")
    return target


def _read_text_capped(path: Path, max_bytes: int) -> Optional[str]:
    with open(path, "rb") as fh:
        data = fh.read(max_bytes + 1)
    if len(data) > max_bytes:
        return None
    return data.decode("utf-8-sig", "replace")


def read_json(*parts: str, default: Any = None) -> Any:
    try:
        text = _read_text_capped(jail_path(*parts), MAX_JSON_FILE_BYTES)
        return json.loads(text) if text is not None else default
    except Exception:
        return default


def read_json_state(*parts: str) -> Tuple[Any, str]:
    """(data, state): state is 'ok', 'missing' or 'unreadable' (present but not parseable)."""
    try:
        path = jail_path(*parts)
    except JailError:
        return None, "unreadable"
    if not path.exists():
        return None, "missing"
    try:
        text = _read_text_capped(path, MAX_JSON_FILE_BYTES)
        if text is None:
            return None, "unreadable"
        return json.loads(text), "ok"
    except Exception:
        return None, "unreadable"


def tail_lines(*parts: str, max_bytes: int = 65536) -> List[str]:
    try:
        path = jail_path(*parts)
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            start = max(0, size - max_bytes)
            fh.seek(start)
            data = fh.read()
    except Exception:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]
    return [ln for ln in lines if ln.strip()]


def parse_jsonl(lines: Iterable[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for ln in lines:
        try:
            obj = json.loads(ln.lstrip(chr(0xFEFF)))
        except Exception:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def list_dir(*parts: str) -> List[os.DirEntry]:
    try:
        path = jail_path(*parts)
        with os.scandir(path) as it:
            return [e for e in it]
    except (OSError, JailError):
        return []


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)


def parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _last_sunday(year: int, month: int) -> date:
    d = date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def uk_offset_hours(dt_utc: datetime) -> int:
    """UK civil time offset (0 or 1) without tzdata: BST runs 01:00 UTC last Sunday of March to October."""
    y = dt_utc.year
    start = datetime(y, 3, _last_sunday(y, 3).day, 1, tzinfo=timezone.utc)
    end = datetime(y, 10, _last_sunday(y, 10).day, 1, tzinfo=timezone.utc)
    return 1 if start <= dt_utc < end else 0


def local_time(dt_utc: datetime, tz_name: str) -> datetime:
    try:
        from zoneinfo import ZoneInfo

        return dt_utc.astimezone(ZoneInfo(tz_name))
    except Exception:
        if tz_name == "Europe/London":
            return dt_utc.astimezone(timezone(timedelta(hours=uk_offset_hours(dt_utc))))
        return dt_utc


def utc_today() -> str:
    return utc_now().date().isoformat()


def in_operating_hours(settings: Dict[str, Any], now: Optional[datetime] = None) -> bool:
    oh = settings["operating_hours"]
    hour = local_time(now or utc_now(), oh["tz"]).hour
    return oh["start"] <= hour < oh["end"]


def age_minutes(dt: Optional[datetime], now: Optional[datetime] = None) -> Optional[int]:
    if dt is None:
        return None
    return max(0, int(((now or utc_now()) - dt).total_seconds() // 60))


def _int_in(value: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if lo <= value <= hi else None


def round_half_up(x: float) -> int:
    """JS Math.round semantics (Python round() is banker's rounding)."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def load_settings() -> Dict[str, Any]:
    """config/dashboard-settings.json merged over DEFAULT_SETTINGS; bad values fall back silently."""
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))
    raw = read_json("config", "dashboard-settings.json", default={})
    if not isinstance(raw, dict):
        return merged
    for key in ("zoho_goal", "caterer_credits_total", "reed_daily_limit", "target_per_day", "target_per_week"):
        v = _int_in(raw.get(key), 1, 10**9)
        if v is not None:
            merged[key] = v
    for key, lo, hi in (("stall_minutes", 1, 1440), ("backup_stale_hours", 1, 24 * 60),
                        ("disk_warn_pct", 1, 100), ("disk_critical_pct", 1, 100)):
        v = _int_in(raw.get(key), lo, hi)
        if v is not None:
            merged[key] = v
    for key in ("caterer_expiry", "reed_expiry"):
        v = raw.get(key)
        if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            merged[key] = v
    if isinstance(raw.get("show_candidate_names"), bool):
        merged["show_candidate_names"] = raw["show_candidate_names"]
    if raw.get("location_mode") in ("outward", "any"):
        merged["location_mode"] = raw["location_mode"]
    oh = raw.get("operating_hours")
    if isinstance(oh, dict):
        start, end = _int_in(oh.get("start"), 0, 23), _int_in(oh.get("end"), 1, 24)
        if start is not None and end is not None and start < end:
            merged["operating_hours"]["start"], merged["operating_hours"]["end"] = start, end
        tz = oh.get("tz")
        if isinstance(tz, str) and re.match(r"^[A-Za-z_]+(/[A-Za-z_+-]+)*$", tz):
            merged["operating_hours"]["tz"] = tz
    return merged


def load_search_defaults() -> Dict[str, Any]:
    """config/territory-defaults.json with the same fallbacks as legacy loadDefaults()."""
    raw = read_json("config", "territory-defaults.json", default={})
    raw = raw if isinstance(raw, dict) else {}
    distance = raw.get("distance") if raw.get("distance") in VALID_DISTANCES and not isinstance(raw.get("distance"), bool) else 20
    active = raw.get("activeWithin") if raw.get("activeWithin") in VALID_ACTIVE_WITHIN else "1 month"
    cv = _int_in(raw.get("cvLimit"), CV_LIMIT_MIN, CV_LIMIT_MAX) or 20
    priority = raw.get("priority") if raw.get("priority") in VALID_PRIORITIES else "low"
    sources = raw.get("sources") if raw.get("sources") in VALID_SOURCES else "both"
    return {"distance": distance, "activeWithin": active, "cvLimit": cv, "priority": priority, "sources": sources}


def ro_connect() -> sqlite3.Connection:
    try:
        db = jail_path("candidates.db")
    except JailError as exc:
        raise DbUnavailable(str(exc))
    if not db.is_file():
        raise DbUnavailable("candidates.db not found")
    uri = "file:" + urllib.parse.quote(db.as_posix(), safe="/:") + "?mode=ro"
    con = None
    try:
        con = sqlite3.connect(uri, uri=True, timeout=DB_BUSY_SECS, check_same_thread=False)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA busy_timeout=%d" % int(DB_BUSY_SECS * 1000))
        con.execute("PRAGMA query_only=ON")
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
        return con
    except sqlite3.Error as exc:
        if con is not None:
            con.close()
        raise DbUnavailable(str(exc))


def _is_missing_schema(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "no such table" in msg or "no such column" in msg


def table_columns(con: sqlite3.Connection, table: str) -> List[str]:
    try:
        return [r["name"] for r in con.execute("PRAGMA table_info(%s)" % table).fetchall()]
    except sqlite3.Error:
        return []


def _db_error_response(exc: BaseException) -> JSONResponse:
    return _err(503, "db_unavailable", "candidates.db is not readable right now: %s" % exc,
                headers={"Retry-After": "5"}, retryAfterSecs=5)


def _err(status: int, code: str, detail: str, headers: Optional[Dict[str, str]] = None, **extra: Any) -> JSONResponse:
    body: Dict[str, Any] = {"error": code, "detail": detail}
    body.update(extra)
    return JSONResponse(status_code=status, content=body, headers=headers)


_CACHE: Dict[str, Tuple[float, Any]] = {}
_CACHE_LOCK = threading.Lock()


def cached(key: str, ttl: float, fn):
    now = time.monotonic()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _CACHE_LOCK:
        _CACHE[key] = (now, value)
    return value


def redact_name(text: str, name: Any) -> str:
    """Remove a candidate name (and each part of it) from free text; the log entry carries the name alongside."""
    if not isinstance(name, str) or not name.strip():
        return text
    parts = {name.strip()} | {p for p in re.split(r"[\s,]+", name) if len(p) >= 3}
    for part in sorted(parts, key=len, reverse=True):
        text = re.sub(re.escape(part), "[name]", text, flags=re.I)
    return text


def scrub(text: Any, limit: int = 300) -> str:
    s = "" if text is None else str(text)
    s = s[: max(limit * 4, 1024)]  # cut first: the scans below must not run over a 64 KB value
    s = _EMAIL_RE.sub("[email]", s)
    s = _PHONE_RE.sub("[number]", s)
    return s[:limit]


def read_halt() -> Dict[str, Any]:
    data, state = read_json_state("runtime", "pipeline-halt.json")
    if state == "missing":
        return {"halted": False}
    if state == "unreadable" or not isinstance(data, dict):
        return {"halted": False, "readError": "runtime/pipeline-halt.json is not readable"}
    if not data.get("halted"):
        return {"halted": False}
    since = parse_iso(data.get("since"))
    out = {
        "halted": True,
        "reason": scrub(data.get("reason"), 200),
        "detail": scrub(data.get("detail"), 600),
        "since": data.get("since") if isinstance(data.get("since"), str) else None,
        "lastCheckedAt": data.get("lastCheckedAt") if isinstance(data.get("lastCheckedAt"), str) else None,
        "blockedRuns": data.get("blockedRuns") if isinstance(data.get("blockedRuns"), int) else 0,
        "remedy": scrub(data.get("remedy"), 600) if data.get("remedy") else None,
        "haltedForMinutes": age_minutes(since),
    }
    return out


def _append_line(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o664)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def clear_halt(actor: str) -> Dict[str, Any]:
    """Same file protocol as lib/pipeline-halt.js clearHalt(): errors.jsonl + alert, then remove the state file."""
    data, state = read_json_state("runtime", "pipeline-halt.json")
    if state != "ok" or not isinstance(data, dict) or not data.get("halted"):
        out: Dict[str, Any] = {"ok": True, "cleared": False}
        if state == "unreadable":
            out["readError"] = "runtime/pipeline-halt.json is not readable; left untouched"
        return out
    now = utc_now()
    since = parse_iso(data.get("since")) or now
    reason = str(data.get("reason") or "unknown")
    blocked = data.get("blockedRuns") if isinstance(data.get("blockedRuns"), int) else 0
    down_min = round_half_up((now - since).total_seconds() / 60.0)
    detail = "was halted for %d min; %d run(s) held back (their territories were NOT consumed)" % (down_min, blocked)
    errors_entry = {
        "ts": iso_z(now),
        "context": "pipeline_resumed",
        "severity": "info",
        "error": "Pipeline resumed " + chr(0x2014) + " %s cleared" % reason,
        "detail": detail,
        "by": actor,
        "via": "dashboard",
    }
    _append_line(jail_path("logs", "errors.jsonl"), json.dumps(errors_entry, ensure_ascii=False, separators=(",", ":")))
    try:
        alert = {
            "ts": iso_z(now),
            "severity": "info",
            "key": "pipeline-halt",
            "text": ("Pipeline resumed - %s cleared. %s" % (reason, detail))[:1000],
            "meta": {"event": "resumed", "reason": reason, "via": "dashboard"},
        }
        _append_line(jail_path("outbox", "alerts.jsonl"), json.dumps(alert, ensure_ascii=False, separators=(",", ":")))
    except Exception:
        pass
    try:
        os.unlink(str(jail_path("runtime", "pipeline-halt.json")))
    except FileNotFoundError:
        pass
    return {
        "ok": True,
        "cleared": True,
        "previous": {
            "reason": scrub(reason, 200),
            "detail": scrub(data.get("detail"), 600),
            "since": data.get("since") if isinstance(data.get("since"), str) else None,
            "blockedRuns": blocked,
        },
    }


def _key(title: Any, location: Any) -> str:
    return "%s|%s" % (str(title or "").strip().lower(), str(location or "").strip().lower())


def _name_date(name: str) -> Optional[str]:
    m = _NAME_DATE_RE.search(name)
    return m.group(1) if m else None


def _load_capped(path: Path, max_bytes: int = 512 * 1024) -> Optional[Dict[str, Any]]:
    try:
        text = _read_text_capped(path, max_bytes)
        obj = json.loads(text) if text is not None else None
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _num(value: Any, default: Optional[int] = None) -> Optional[int]:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def scan_runs(now: Optional[datetime] = None) -> Dict[str, Any]:
    """Derive in-flight runs from runs/*.json (files only): cheap, bounded, never raises."""
    now = now or utc_now()
    cutoff_date = (now.date() - timedelta(days=2)).isoformat()
    candidates: List[Tuple[str, os.DirEntry]] = []
    for entry in list_dir("runs"):
        name = entry.name
        if name.startswith(".") or not name.endswith(".json"):
            continue
        if not (name.startswith("phase1-") or name.startswith("run-")):
            continue
        nd = _name_date(name)
        if nd is not None and nd < cutoff_date:
            continue
        candidates.append((name, entry))
    candidates.sort(key=lambda t: t[0], reverse=True)
    phase1_names = [c for c in candidates if c[0].startswith("phase1-")][:RUN_SCAN_CAP]
    run_names = [c for c in candidates if c[0].startswith("run-")][:RUN_SCAN_CAP]
    candidates = phase1_names + run_names

    terminal_ms: Dict[str, float] = {}
    phase2: List[Dict[str, Any]] = []
    phase1: List[Dict[str, Any]] = []
    newest_mtime: Optional[float] = None
    for name, entry in candidates:
        try:
            path = jail_path("runs", name)
            mtime = path.stat().st_mtime
        except (OSError, JailError):
            continue
        newest_mtime = mtime if newest_mtime is None else max(newest_mtime, mtime)
        data = _load_capped(path)
        if not data:
            continue
        status = data.get("status")
        key = _key(data.get("jobTitle"), data.get("location"))
        if name.startswith("run-"):
            if status in ("complete", "error"):
                done_dt = parse_iso(data.get("completedAt") or data.get("updatedAt") or data.get("startedAt"))
                ms = done_dt.timestamp() if done_dt else mtime
                terminal_ms[key] = max(terminal_ms.get(key, 0.0), ms)
            elif status in PHASE2_ACTIVE:
                phase2.append({"name": name, "data": data, "mtime": mtime})
        else:
            if status in STATUS_MAX_AGE_MIN and status not in PHASE2_ACTIVE:
                phase1.append({"name": name, "data": data, "mtime": mtime})

    active: List[Dict[str, Any]] = []
    covered = set()
    for item in phase2:
        rec = _run_record(item, now, phase2=True)
        if rec:
            active.append(rec)
            covered.add(_key(item["data"].get("jobTitle"), item["data"].get("location")))
    for item in phase1:
        data = item["data"]
        key = _key(data.get("jobTitle"), data.get("location"))
        if key in covered:
            continue
        if data.get("status") == "phase1_complete" and data.get("phase2Status") == "done":
            continue
        if terminal_ms.get(key, 0.0) >= item["mtime"]:
            continue
        rec = _run_record(item, now, phase2=False)
        if rec:
            active.append(rec)
    active.sort(key=lambda r: r.get("startedAt") or "", reverse=True)
    return {"active": active, "newestMtime": newest_mtime}


def _run_record(item: Dict[str, Any], now: datetime, phase2: bool) -> Optional[Dict[str, Any]]:
    data = item["data"]
    status = data.get("status")
    updated = parse_iso(data.get("updatedAt")) or datetime.fromtimestamp(item["mtime"], tz=timezone.utc)
    mtime_dt = datetime.fromtimestamp(item["mtime"], tz=timezone.utc)
    last_touch = max(updated, mtime_dt)
    idle_secs = max(0, int((now - last_touch).total_seconds()))
    if idle_secs > LIVE_WINDOW_SECS:
        return None
    sources = data.get("sources") if data.get("sources") in VALID_SOURCES else "caterer"
    max_age = STATUS_MAX_AGE_MIN.get(status, 30)
    if status == "phase1_complete" and sources in ("both", "reed"):
        max_age = 60
    if phase2:
        stage, label = "phase2", "Phase 2 - Zoho push"
    elif status in ("phase1_initializing", "phase1_taking_over"):
        stage, label = "initializing", "Phase 1 - Logging in"
    elif status == "phase1_complete":
        stage = "reed" if sources in ("both", "reed") else "handoff"
        label = "Phase 1 done - Reed / hand-off" if stage == "reed" else "Phase 1 done - hand-off to Phase 2"
    else:
        stage, label = "phase1", "Phase 1 - Scraping"
    started = data.get("phase1StartedAt") if phase2 and data.get("phase1StartedAt") else data.get("startedAt")
    rec: Dict[str, Any] = {
        "id": str(data.get("id") or item["name"])[:80],
        "file": item["name"],
        "status": status,
        "stage": stage,
        "label": label,
        "jobTitle": scrub(data.get("jobTitle"), 80),
        "location": scrub(data.get("location"), 40),
        "distance": _num(data.get("distance"), 20),
        "sources": sources,
        "startedAt": started if isinstance(started, str) else None,
        "updatedAt": iso_z(last_touch),
        "idleSecs": idle_secs,
        "stale": idle_secs > max_age * 60,
    }
    p2 = data.get("phase2") if isinstance(data.get("phase2"), dict) else {}
    rec["phase2"] = {
        "total": _num(p2.get("total")), "pushed": _num(p2.get("pushed"), 0), "duplicates": _num(p2.get("duplicates"), 0),
        "errors": _num(p2.get("errors"), 0),
    } if phase2 else None
    rec["phase1"] = None if phase2 else {
        "page": _num(data.get("page"), 0), "pool": _num(data.get("pool")), "approved": _num(data.get("approved"), 0),
        "skippedDb": _num(data.get("skippedDb")), "errors": _num(data.get("errors")),
    }
    return rec


def scan_pending(now: Optional[datetime] = None) -> Dict[str, Any]:
    """pending-searches/*.json exactly as pending-gate.js sees them (only names ending .json, sorted)."""
    now = now or utc_now()
    names = sorted(e.name for e in list_dir("pending-searches") if e.name.endswith(".json") and not e.name.startswith("."))
    items: List[Dict[str, Any]] = []
    skipped = 0
    for name in names[:PENDING_PARSE_CAP]:
        try:
            data = _load_capped(jail_path("pending-searches", name), 64 * 1024)
        except JailError:
            data = None
        if data is None:
            skipped += 1
            continue
        claimed_at = parse_iso(data.get("spawnedAt")) if data.get("spawnedAt") else None
        claim_age = (now - claimed_at).total_seconds() if claimed_at else None
        items.append({
            "file": name,
            "jobTitle": scrub(data.get("jobTitle"), 80),
            "location": scrub(data.get("location"), 40),
            "distance": _num(data.get("distance")),
            "keywords": scrub(data.get("keywords"), 60),
            "sources": data.get("sources") if data.get("sources") in VALID_SOURCES else None,
            "source": scrub(data.get("source"), 60) if data.get("source") else None,
            "requestedAt": data.get("requestedAt") if isinstance(data.get("requestedAt"), str) else None,
            "claimed": bool(data.get("spawnedAt")),
            "claimFresh": claim_age is not None and claim_age < CLAIM_STALE_SECS,
        })
    return {"names": names, "items": items, "unparsed": skipped}


def queue_summary(now: Optional[datetime] = None) -> Dict[str, Any]:
    pend = scan_pending(now)
    items = pend["items"]
    up_next = [i for i in items if not i["claimFresh"]][:5]
    return {
        "depth": len(pend["names"]),
        "claimed": sum(1 for i in items if i["claimFresh"]),
        "dashboardRequests": sum(1 for i in items if i["source"] == "dashboard"),
        "unreadable": pend["unparsed"],
        "upNext": [
            {k: i[k] for k in ("file", "jobTitle", "location", "distance", "sources", "source", "requestedAt", "claimed")}
            for i in up_next
        ],
    }


def last_watchdog_events(max_bytes: int = 262144) -> List[Dict[str, Any]]:
    return parse_jsonl(tail_lines("logs", "watchdog-runner.jsonl", max_bytes=max_bytes))


_HEARTBEAT_RE = re.compile(r"(heartbeat|\.hb$|\.pid$)", re.I)


def last_activity(runs_newest_mtime: Optional[float], events: List[Dict[str, Any]]) -> Optional[datetime]:
    best: Optional[datetime] = None

    def consider(dt: Optional[datetime]) -> None:
        nonlocal best
        if dt is not None and (best is None or dt > best):
            best = dt

    if runs_newest_mtime:
        consider(datetime.fromtimestamp(runs_newest_mtime, tz=timezone.utc))
    if events:
        consider(parse_iso(events[-1].get("ts")))
    for entry in list_dir("runtime"):
        if _HEARTBEAT_RE.search(entry.name):
            try:
                consider(datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc))
            except OSError:
                pass
    return best


_CATERER_EVENT_STATE = {
    "session-safelist-blocked": "safelist_blocked",
    "session-dead": "stale",
    "session-stale": "stale",
    "session-relogin": "relogin",
    "session-loaded": "ok",
    "phase1-start": "ok",
    "done": "ok",
}


def caterer_state(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Explicit runtime/caterer-status.json {state, updatedAt, detail} vs the newest session event in
    logs/watchdog-runner.jsonl; whichever is newer wins."""
    derived: Dict[str, Any] = {"state": "unknown", "updatedAt": None, "detail": None, "source": "none"}
    for ev in reversed(events):
        state = _CATERER_EVENT_STATE.get(str(ev.get("event")))
        if state is None:
            continue
        note = str(ev.get("note") or "")
        if str(ev.get("event")) == "session-dead" and re.search(r"safelist", note, re.I):
            state = "safelist_blocked"
        derived = {"state": state, "updatedAt": ev.get("ts"), "detail": scrub(note, 200) or None,
                   "source": "logs/watchdog-runner.jsonl"}
        break
    explicit = read_json("runtime", "caterer-status.json", default=None)
    if isinstance(explicit, dict) and isinstance(explicit.get("state"), str):
        e_dt, d_dt = parse_iso(explicit.get("updatedAt")), parse_iso(derived["updatedAt"])
        if derived["state"] == "unknown" or (e_dt is not None and (d_dt is None or e_dt >= d_dt)):
            derived = {"state": scrub(explicit["state"], 40), "updatedAt": explicit.get("updatedAt"),
                       "detail": scrub(explicit.get("detail"), 200) or None, "source": "runtime/caterer-status.json"}
    dt = parse_iso(derived["updatedAt"])
    derived["ageMinutes"] = age_minutes(dt)
    return derived


def _env_candidates() -> List[Path]:
    """env.js candidateEnvFiles() order (RESOURCER_ENV_FILE, profile .env, workspace .env), limited to the resourcer
    profile and workspace: a machine-level or foreign file is never a candidate."""
    home = get_home().resolve()
    profile: Optional[Path] = home.parent.parent
    roots = [home]
    if home.parent.name == "workspace" and len(profile.parts) >= 2 and not (profile / "profiles").is_dir() and not (profile / "plugins").is_dir():
        roots.append(profile)
    else:
        profile = None
    raw: List[Path] = []
    override = os.environ.get("RESOURCER_ENV_FILE")
    if override:
        raw.append(Path(override))
    if profile is not None:
        raw.append(profile / ".env")
    raw.append(home / ".env")
    out: List[Path] = []
    for cand in raw:
        real = Path(os.path.realpath(cand))
        for root in roots:
            try:
                rel = real.relative_to(root)
            except ValueError:
                continue
            if not any(part.lower() in _DENY_DIRS for part in rel.parts):
                out.append(real)
            break
    return out


def _read_env_setting(path: Path) -> Tuple[bool, Optional[str]]:
    """(readable, RESOURCER_SOURCES as written or None). Only that one key is extracted; no other line is kept or returned.
    Binary, non-UTF-8, over-size or non-regular files are unreadable, not 'no setting'."""
    try:
        if not os.path.isfile(path):
            return False, None
        with open(path, "rb") as fh:
            data = fh.read(ENV_FILE_MAX_BYTES + 1)
        if len(data) > ENV_FILE_MAX_BYTES or b"\x00" in data:
            return False, None
        text = data.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return False, None
    value: Optional[str] = None
    for line in re.split(r"\r?\n", text):
        m = _SOURCES_LINE_RE.match(line.strip())
        if m:
            value = m.group(1).strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
    return True, value


def reed_source_setting() -> Optional[Dict[str, Any]]:
    """Effective RESOURCER_SOURCES the way scripts/lib/env.js resolves it: a non-empty process variable, else the first env
    file that defines it (an empty value means unset), else the pipeline default caterer.

    -> {"value": caterer|reed|both, "valid": bool, "origin": process|file|default}; anything that is not caterer|reed|both
    counts as caterer (reed-api-client.js sourcesGate). None when no source could be read at all (no process variable and
    no readable env file), so the caller can fall back to what the pipeline recorded.
    """
    raw = os.environ.get("RESOURCER_SOURCES")
    origin = "process"
    if raw is None or raw == "":
        raw, origin = None, "file"
        try:
            candidates = _env_candidates()
        except (JailError, OSError, ValueError):
            candidates = []
        readable = False
        for path in candidates:
            ok, value = _read_env_setting(path)
            if not ok:
                continue
            readable = True
            if value is not None:
                raw = value
                break
        if not readable:
            return None
        if not raw:
            return {"value": "caterer", "valid": True, "origin": "default"}
    norm = raw.strip().lower()
    valid = norm in ("caterer", "reed", "both")
    return {"value": norm if valid else "caterer", "valid": valid, "origin": origin}


def reed_state(reed_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Reed auth. RESOURCER_SOURCES decides first: a Reed that is switched off is 'disabled' whatever old runs say. Otherwise
    failure marker (runtime/ or root), explicit runtime/reed-status.json, else last run's reed stats; a switched-on Reed with no
    recorded successful login is 'not_logged_in', never 'ok' from imported run history."""
    setting = reed_source_setting()
    sources = setting["value"] if setting else None
    enabled = None if setting is None else sources in ("reed", "both")
    if enabled is False:
        if setting["origin"] == "default":
            detail = "RESOURCER_SOURCES is not set (default caterer): Reed is off"
        elif not setting["valid"]:
            detail = "RESOURCER_SOURCES is not caterer, reed or both: treated as caterer, Reed is off"
        else:
            detail = "RESOURCER_SOURCES=" + sources
        return {"state": "disabled", "updatedAt": None, "detail": detail, "source": "RESOURCER_SOURCES", "ageMinutes": None,
                "enabled": False, "sources": sources}
    marker, mstate = read_json_state("runtime", "reed-auth-failed.marker")
    if mstate == "missing":
        marker, mstate = read_json_state("reed-auth-failed.marker")
    state: Dict[str, Any] = {"state": "unknown", "updatedAt": None, "detail": None, "source": "none"}
    if reed_rows:
        last = reed_rows[0]
        state = {
            "state": "auth_failed" if last.get("authFailed") else "ok",
            "updatedAt": last.get("at"),
            "detail": scrub(last.get("authFailureReason"), 120) or None,
            "source": "run_results",
        }
    explicit = read_json("runtime", "reed-status.json", default=None)
    explicit_state = explicit["state"] if isinstance(explicit, dict) and isinstance(explicit.get("state"), str) else None
    if enabled and explicit_state == "disabled":
        explicit_state = None  # written while Reed was off; Reed is on now
    if explicit_state is not None:
        e_dt, s_dt = parse_iso(explicit.get("updatedAt")), parse_iso(state["updatedAt"])
        if state["state"] == "unknown" or (e_dt is not None and (s_dt is None or e_dt >= s_dt)):
            state = {"state": scrub(explicit_state, 40), "updatedAt": explicit.get("updatedAt"),
                     "detail": scrub(explicit.get("detail"), 200) or None, "source": "runtime/reed-status.json"}
    if mstate in ("ok", "unreadable"):
        m = marker if isinstance(marker, dict) else {}
        m_dt, s_dt = parse_iso(m.get("failedAt")), parse_iso(state["updatedAt"])
        if m_dt is None or s_dt is None or m_dt >= s_dt:
            state = {"state": "auth_failed", "updatedAt": m.get("failedAt") if isinstance(m.get("failedAt"), str) else None,
                     "detail": scrub(m.get("reason"), 120) or None, "source": "reed-auth-failed.marker"}
    if enabled and state["state"] != "auth_failed" and explicit_state != "ok":
        state = {"state": "not_logged_in", "updatedAt": None, "source": "none",
                 "detail": "Reed is on (RESOURCER_SOURCES=%s) but no successful Reed login is recorded yet" % sources}
    state["ageMinutes"] = age_minutes(parse_iso(state["updatedAt"]))
    state["enabled"] = enabled
    state["sources"] = sources
    return state


def backup_state(settings: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    newest: Optional[float] = None
    newest_name: Optional[str] = None
    count = 0
    stack = [("backups", 0)]
    while stack:
        rel, depth = stack.pop()
        for entry in list_dir(rel):
            name = entry.name
            # a pre-migration copy or a bundle-restore safety copy is not a nightly backup (it is not even encrypted)
            if name.startswith(".") or name.endswith((".tmp", ".partial", ".part", ".lock")) or ".pre-migrate-" in name:
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    if depth < 1 and not name.startswith("bundle-restore-"):
                        stack.append((rel + "/" + name, depth + 1))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if name.endswith(".json"):
                continue
            count += 1
            if newest is None or mtime > newest:
                newest, newest_name = mtime, name
    out: Dict[str, Any] = {"count": count, "lastAt": None, "ageHours": None, "file": newest_name, "stale": True, "source": "files"}
    if newest is not None:
        dt = datetime.fromtimestamp(newest, tz=timezone.utc)
        out["lastAt"] = iso_z(dt)
        out["ageHours"] = round((now - dt).total_seconds() / 3600.0, 1)
        out["stale"] = out["ageHours"] > settings["backup_stale_hours"]
    status = read_json("runtime", "backup-status.json", default=None)
    if isinstance(status, dict):
        ok = status.get("ok")
        out["lastResultOk"] = ok if isinstance(ok, bool) else None
        out["lastResultAt"] = status.get("finishedAt") if isinstance(status.get("finishedAt"), str) else None
        out["lastError"] = scrub(status.get("error"), 200) if status.get("error") else None
        if ok is False:
            out["stale"] = True
    return out


def disk_state(settings: Dict[str, Any]) -> Dict[str, Any]:
    try:
        usage = shutil.disk_usage(str(jail_path()))
    except (OSError, JailError):
        return {"available": False}
    pct = round(usage.used * 100.0 / usage.total, 1) if usage.total else 0.0
    level = "critical" if pct >= settings["disk_critical_pct"] else "warn" if pct >= settings["disk_warn_pct"] else "ok"
    return {"available": True, "totalBytes": usage.total, "usedBytes": usage.used, "freeBytes": usage.free,
            "percentUsed": pct, "level": level}


def alerts_tail(limit: int = 15, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    entries = parse_jsonl(tail_lines("outbox", "alerts.jsonl", max_bytes=131072))
    out = []
    crit_24h = 0
    for e in entries:
        dt = parse_iso(e.get("ts"))
        if e.get("severity") == "critical" and dt and (now - dt) < timedelta(hours=24):
            crit_24h += 1
    for e in reversed(entries[-limit:]):
        out.append({
            "ts": e.get("ts") if isinstance(e.get("ts"), str) else None,
            "severity": e.get("severity") if e.get("severity") in ("info", "warn", "critical") else "info",
            "key": scrub(e.get("key"), 60) if e.get("key") else None,
            "text": scrub(e.get("text"), 300),
        })
    return {"tail": out, "critical24h": crit_24h}


def _run_result_cols(con: sqlite3.Connection) -> List[str]:
    return table_columns(con, "run_results")


def last_push_and_reed() -> Dict[str, Any]:
    """Last successful push (run_results, else candidates.zoho_pushed_at) and recent Reed run stats."""
    out: Dict[str, Any] = {"lastPushAt": None, "lastPushSource": None, "reedRows": [], "dbOk": True, "dbError": None}
    try:
        con = ro_connect()
    except DbUnavailable as exc:
        out.update(dbOk=False, dbError=str(exc))
        return out
    try:
        cols = _run_result_cols(con)
        if "completed_at" in cols and "new_to_zoho" in cols:
            row = con.execute("SELECT MAX(completed_at) AS m FROM run_results WHERE new_to_zoho > 0").fetchone()
            if row and row["m"]:
                out["lastPushAt"], out["lastPushSource"] = row["m"], "run_results"
        if out["lastPushAt"] is None and "zoho_pushed_at" in table_columns(con, "candidates"):
            row = con.execute("SELECT MAX(zoho_pushed_at) AS m FROM candidates").fetchone()
            if row and row["m"]:
                out["lastPushAt"], out["lastPushSource"] = row["m"], "candidates"
        if "reed_json" in cols and "completed_at" in cols:
            for r in con.execute(
                "SELECT completed_at, reed_json FROM run_results WHERE reed_json IS NOT NULL "
                "ORDER BY completed_at DESC LIMIT 3"
            ).fetchall():
                stats = _safe_json_dict(r["reed_json"])
                if stats is not None:
                    out["reedRows"].append({"at": r["completed_at"], "authFailed": bool(stats.get("authFailed")),
                                            "authFailureReason": stats.get("authFailureReason")})
    except sqlite3.Error as exc:
        if not _is_missing_schema(exc):
            out.update(dbOk=False, dbError=str(exc))
    finally:
        con.close()
    return out


def _safe_json_dict(text: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(text, str) or not text:
        return None
    try:
        obj = json.loads(text)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


_COUNT_KEYS = ("pool", "newToZoho", "downloaded", "duplicates", "skipped", "errors")
_P1_KEYS = ("pagesScraped", "approved", "skippedDb", "skippedReview")


def source_breakdown(text: Any) -> Optional[Dict[str, Any]]:
    obj = _safe_json_dict(text)
    if obj is None:
        return None
    out: Dict[str, Any] = {k: _num(obj.get(k)) for k in _COUNT_KEYS}
    p1 = obj.get("phase1") if isinstance(obj.get("phase1"), dict) else {}
    out["phase1"] = {k: _num(p1.get(k)) for k in _P1_KEYS}
    out["authFailed"] = bool(obj.get("authFailed"))
    if obj.get("authFailureReason"):
        out["authFailureReason"] = scrub(obj.get("authFailureReason"), 120)
    return out


def normalise_title(raw: str) -> str:
    words = _WS_RE.sub(" ", raw.strip()).split(" ")
    out = []
    for w in words:
        up = w.upper()
        out.append(up if up in ACRONYMS else w[:1].upper() + w[1:].lower())
    return " ".join(out)


def normalise_location(raw: str) -> str:
    return _WS_RE.sub(" ", raw.strip().upper())


def normalise_keywords(raw: str) -> str:
    text = raw.strip()
    if not text or _KEYWORD_NONE_RE.match(text):
        return ""
    tokens = [t for t in _KEYWORD_SPLIT_RE.split(text.lower()) if t]
    tokens = [t for t in tokens if not _KEYWORD_DROP_RE.match(t)]
    return " ".join(sorted(set(tokens)))


def _to_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        try:
            return int(value) if value == int(value) else None
        except (ValueError, OverflowError):
            return None
    if isinstance(value, str) and re.match(r"^\s*\d{1,6}\s*$", value):
        return int(value.strip())
    return None


class ValidationError(Exception):
    def __init__(self, field: str, detail: str):
        super().__init__(detail)
        self.field = field
        self.detail = detail


def _location_error() -> str:
    return "Enter the postcode area only (outward code such as YO2, M1, LS1), not a city name or a full postcode."


def validate_search(payload: Dict[str, Any], defaults: Dict[str, Any], location_mode: str = "outward") -> Dict[str, Any]:
    """Return the normalised request fields (no requestedAt/source) or raise ValidationError."""
    title_raw = payload.get("jobTitle")
    if not isinstance(title_raw, str) or not title_raw.strip():
        raise ValidationError("jobTitle", "Job title is required")
    if not _TITLE_CHARS.match(_WS_RE.sub(" ", title_raw.strip())):
        raise ValidationError("jobTitle", "Job title may only contain letters, numbers, spaces and & ' . / ( ) + -")
    title = normalise_title(title_raw)
    if not 2 <= len(title) <= 60:
        raise ValidationError("jobTitle", "Job title must be 2 to 60 characters")

    loc_raw = payload.get("location")
    if not isinstance(loc_raw, str) or not loc_raw.strip():
        raise ValidationError("location", "Location is required")
    if not _LOCATION_CHARS.match(_WS_RE.sub(" ", loc_raw.strip())):
        raise ValidationError("location", _location_error())
    location = normalise_location(loc_raw)
    if _OUTWARD_RE.match(location):
        pass
    elif location_mode == "any" and _POSTCODE_RE.match(location):
        m = _POSTCODE_RE.match(location)
        location = "%s %s" % (m.group(1), m.group(2))
    elif location_mode == "any" and location.lower() not in CITY_NAMES and _PLACE_RE.match(location):
        pass
    else:
        raise ValidationError("location", _location_error())

    kw_raw = payload.get("keywords", "")
    if kw_raw is None:
        kw_raw = ""
    if not isinstance(kw_raw, str) or len(kw_raw) > 120 or not _KEYWORD_CHARS.match(kw_raw):
        raise ValidationError("keywords", "Keywords may only contain letters, numbers, spaces and , . & ' / + : ( ) _ - (max 120 characters)")
    keywords = normalise_keywords(kw_raw)
    if len(keywords) > 60:
        raise ValidationError("keywords", "Keywords are too long (max 60 characters once normalised)")

    sources = payload.get("sources", defaults["sources"])
    if sources is None:
        sources = defaults["sources"]
    if sources not in VALID_SOURCES:
        raise ValidationError("sources", "Source must be one of: both, caterer, reed")
    priority = payload.get("priority", defaults["priority"])
    if priority is None:
        priority = defaults["priority"]
    if priority not in VALID_PRIORITIES:
        raise ValidationError("priority", "Priority must be one of: high, medium, low")

    dist_raw = payload.get("distance")
    distance = defaults["distance"] if dist_raw in (None, "") else _to_int(dist_raw)
    if distance not in VALID_DISTANCES:
        raise ValidationError("distance", "Distance must be one of: " + ", ".join(str(d) for d in VALID_DISTANCES) + " miles")
    active = payload.get("activeWithin")
    active = defaults["activeWithin"] if active in (None, "") else active
    if not isinstance(active, str) or active.strip() not in VALID_ACTIVE_WITHIN:
        raise ValidationError("activeWithin", "Active within must be one of: " + ", ".join(VALID_ACTIVE_WITHIN))
    active = active.strip()
    cv_raw = payload.get("cvLimit")
    cv_limit = defaults["cvLimit"] if cv_raw in (None, "") else _to_int(cv_raw)
    if cv_limit is None or not CV_LIMIT_MIN <= cv_limit <= CV_LIMIT_MAX:
        raise ValidationError("cvLimit", "CVs per run must be a whole number from %d to %d" % (CV_LIMIT_MIN, CV_LIMIT_MAX))

    overrides = [k for k, v in (("distance", distance), ("activeWithin", active), ("cvLimit", cv_limit)) if v != defaults[k]]
    return {
        "jobTitle": title, "location": location, "keywords": keywords, "priority": priority, "sources": sources,
        "distance": distance, "activeWithin": active, "cvLimit": cv_limit, "overrides": overrides,
    }


def _random_suffix() -> str:
    return secrets.token_hex(3)


def new_search_filename(now: datetime) -> str:
    return "search-%d-%s.json" % (int(now.timestamp() * 1000), _random_suffix())


def write_new_file_atomic(directory: Path, make_name, text: str) -> str:
    """Write text to directory/<make_name()> without ever overwriting: temp dotfile + fsync + link (fallback rename)."""
    directory.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8")
    for _ in range(8):
        name = make_name()
        tmp = directory / (".%s.%s.tmp" % (name, secrets.token_hex(4)))
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o664)
        try:
            try:
                os.write(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            final = directory / name
            try:
                os.link(str(tmp), str(final))
            except FileExistsError:
                continue
            except OSError as exc:
                if exc.errno not in (errno.EPERM, errno.EXDEV, errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS, errno.EACCES):
                    raise
                if final.exists():
                    continue
                os.replace(str(tmp), str(final))
            try:
                os.chmod(str(final), 0o664)
            except OSError:
                pass
            try:
                dfd = os.open(str(directory), os.O_RDONLY)
                try:
                    os.fsync(dfd)
                finally:
                    os.close(dfd)
            except OSError:
                pass
            return name
        finally:
            try:
                os.unlink(str(tmp))
            except FileNotFoundError:
                pass
    raise OSError("could not allocate a unique file name")


_SEARCH_LOCK = threading.Lock()


class _DirLock:
    """Advisory lock file shared with tools/request-search.js so two writers cannot both pass the duplicate check."""

    def __init__(self, directory: Path):
        self.path = directory / ".request-search.lock"
        self.held = False
        self.token = secrets.token_hex(8)

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + LOCK_WAIT_SECS
        while True:
            try:
                fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o664)
                os.write(fd, ("%d %d %s" % (os.getpid(), int(time.time()), self.token)).encode("ascii"))
                os.close(fd)
                self.held = True
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > LOCK_STALE_SECS:
                        os.unlink(str(self.path))
                        continue
                except OSError:
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError("another search request is being written; try again")
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self.held:
            try:
                with open(self.path, "rb") as fh:
                    mine = self.token.encode("ascii") in fh.read(200)
                if mine:
                    os.unlink(str(self.path))
            except FileNotFoundError:
                pass
        return False


def find_duplicate(title: str, location: str, now: datetime) -> Optional[Dict[str, Any]]:
    key = _key(title, location)
    for item in scan_pending(now)["items"]:
        if _key(item["jobTitle"], item["location"]) == key:
            return {"where": "pending", "file": item["file"], "jobTitle": item["jobTitle"], "location": item["location"],
                    "distance": item["distance"], "keywords": item["keywords"], "sources": item["sources"],
                    "claimed": item["claimed"]}
    for run in scan_runs(now)["active"]:
        if not run["stale"] and _key(run["jobTitle"], run["location"]) == key:
            return {"where": "in_flight", "file": None, "jobTitle": run["jobTitle"], "location": run["location"],
                    "distance": run["distance"], "keywords": "", "sources": run["sources"], "claimed": True,
                    "stage": run["stage"]}
    return None


def enqueue_search(payload: Dict[str, Any], settings: Dict[str, Any], now: Optional[datetime] = None, actor: Optional[str] = None) -> Tuple[int, Dict[str, Any]]:
    """Validate, dedupe and write. Returns (http_status, body)."""
    now = now or utc_now()
    defaults = load_search_defaults()
    try:
        fields = validate_search(payload, defaults, settings["location_mode"])
    except ValidationError as exc:
        return 400, {"error": "validation", "field": exc.field, "detail": exc.detail}
    request = dict(fields)
    request["requestedAt"] = iso_z(now)
    request["source"] = "dashboard"
    if actor:
        request["requestedBy"] = scrub(actor, 64)
    pending_dir = jail_path("pending-searches")
    with _SEARCH_LOCK:
        with _DirLock(pending_dir):
            dup = find_duplicate(fields["jobTitle"], fields["location"], now)
            if dup is not None:
                return 409, {
                    "error": "already_queued",
                    "detail": "%s | %s is already %s; it will run in queue order." % (
                        dup["jobTitle"], dup["location"], "running" if dup["where"] == "in_flight" else "queued"),
                    "file": dup["file"], "existing": dup,
                }
            waiting = scan_pending(now)
            manual = sum(1 for i in waiting["items"] if not i["claimFresh"] and i["source"] in MANUAL_SOURCES)
            if manual >= SEARCH_QUEUE_CAP or len(waiting["names"]) > PENDING_PARSE_CAP:
                return 429, {
                    "error": "queue_full",
                    "detail": "%d manual searches are already waiting (limit %d); they run in queue order, so try again later." % (manual, SEARCH_QUEUE_CAP),
                    "waiting": manual, "limit": SEARCH_QUEUE_CAP,
                }
            text = json.dumps(request, indent=2, ensure_ascii=True) + "\n"
            name = write_new_file_atomic(pending_dir, lambda: new_search_filename(now), text)
            written = _load_capped(jail_path("pending-searches", name), 64 * 1024)
            if written is None or "spawnedAt" in written:
                try:
                    os.unlink(str(jail_path("pending-searches", name)))
                except OSError:
                    pass
                return 500, {"error": "write_verify_failed", "detail": "the queued file could not be read back; nothing was queued"}
    pend = scan_pending(now)
    unclaimed = [i["file"] for i in pend["items"] if not i["claimFresh"]]
    position = unclaimed.index(name) + 1 if name in unclaimed else None
    halt = read_halt()
    inside = in_operating_hours(settings, now)
    oh = settings["operating_hours"]
    if halt.get("halted"):
        note = "The pipeline is halted (%s). The search is queued and will start when the halt clears." % halt.get("reason")
    elif inside:
        note = "Queued. It is picked up in queue order (ahead of scheduled territories) during operating hours (%02d:00-%02d:00 %s)." % (oh["start"], oh["end"], oh["tz"])
    else:
        note = "Queued. It will start when operating hours begin (%02d:00-%02d:00 %s)." % (oh["start"], oh["end"], oh["tz"])
    return 200, {
        "ok": True, "file": name, "queueDepthAfter": len(pend["names"]), "position": position,
        "pipelineHalted": bool(halt.get("halted")), "inOperatingHours": inside, "note": note, "request": request,
    }


async def _read_json_body(request: Request) -> Tuple[Optional[Dict[str, Any]], Optional[JSONResponse]]:
    # Defence in depth for state-changing routes: a browser marks cross-site requests itself, Hermes does the rest.
    site = (request.headers.get("sec-fetch-site") or "").strip().lower()
    if site and site not in ("same-origin", "none"):
        return None, _err(403, "cross_site", "cross-site requests are not accepted")
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype != "application/json":
        return None, _err(415, "unsupported_media_type", "Content-Type must be application/json")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return None, _err(413, "payload_too_large", "request body is limited to %d bytes" % MAX_BODY_BYTES)
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_BODY_BYTES:
            return None, _err(413, "payload_too_large", "request body is limited to %d bytes" % MAX_BODY_BYTES)
    if not buf.strip():
        return {}, None
    try:
        body = json.loads(bytes(buf).decode("utf-8-sig"))
    except Exception:
        return None, _err(400, "bad_json", "request body is not valid JSON")
    if not isinstance(body, dict):
        return None, _err(400, "bad_json", "request body must be a JSON object")
    return body, None


def _actor(request: Request) -> str:
    session = getattr(request.state, "session", None)
    uid = getattr(session, "user_id", None)
    return str(uid)[:64] if uid else "dashboard-user"


def _qp(request: Request, name: str, default: str = "", max_len: int = 60) -> str:
    return (request.query_params.get(name) or default).strip()[:max_len]


def _qint(request: Request, name: str, default: int, lo: int, hi: int) -> int:
    raw = request.query_params.get(name)
    try:
        value = int(raw) if raw is not None else default
    except ValueError:
        value = default
    return max(lo, min(hi, value))


def _like_escape(text: str) -> str:
    return text.replace("!", "!!").replace("%", "!%").replace("_", "!_")


def _fmt_day(d: date, today: date) -> str:
    diff = (d - today).days
    if diff < 0:
        return "Overdue by %d day%s" % (-diff, "" if diff == -1 else "s")
    if diff == 0:
        return "Due today"
    if diff == 1:
        return "Tomorrow"
    return d.strftime("%a %d %b")


@router.get("/health", response_model=None)
def health(request: Request):
    """Install smoke test. Never raises: every check is a boolean."""
    checks: Dict[str, Any] = {}
    try:
        home = get_home()
    except JailError as exc:
        return {"ok": False, "plugin": PLUGIN_NAME, "version": PLUGIN_VERSION, "home": None, "generatedAt": iso_z(utc_now()),
                "python": sys.version.split()[0], "sqliteVersion": sqlite3.sqlite_version, "checks": checks, "error": str(exc)[:200]}
    out: Dict[str, Any] = {"ok": False, "plugin": PLUGIN_NAME, "version": PLUGIN_VERSION, "home": str(home),
                           "generatedAt": iso_z(utc_now()), "python": sys.version.split()[0],
                           "sqliteVersion": sqlite3.sqlite_version, "checks": checks}
    try:
        import fastapi  # noqa: WPS433

        out["fastapi"] = getattr(fastapi, "__version__", None)
    except Exception:
        out["fastapi"] = None
    try:
        checks["homeExists"] = jail_path().is_dir()
        checks["dbFile"] = jail_path("candidates.db").is_file()
        checks["dbOpen"] = False
        checks["dbTables"] = []
        checks["runResultsTable"] = False
        try:
            con = ro_connect()
            try:
                checks["dbOpen"] = True
                checks["dbTables"] = [r["name"] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
                checks["runResultsTable"] = "run_results" in checks["dbTables"]
            finally:
                con.close()
        except DbUnavailable as exc:
            checks["dbError"] = str(exc)[:200]
        for label, rel in (("runsDirReadable", "runs"), ("logsDirReadable", "logs"), ("runtimeDirReadable", "runtime")):
            p = jail_path(rel)
            checks[label] = p.is_dir() and os.access(str(p), os.R_OK | os.X_OK)
        p = jail_path("pending-searches")
        checks["pendingDirExists"] = p.is_dir()
        parent = p if p.is_dir() else p.parent
        checks["pendingDirWritable"] = os.access(str(parent), os.W_OK | os.X_OK)
        checks["settingsFile"] = jail_path("config", "dashboard-settings.json").is_file()
        out["ok"] = bool(checks["homeExists"] and checks["dbOpen"])
    except Exception as exc:
        out["error"] = str(exc)[:200]
    return out


@router.get("/halt", response_model=None)
def get_halt():
    return read_halt()


@router.get("/status", response_model=None)
def status(request: Request):
    """Everything the live panels need, from files only plus two cached read-only DB lookups."""
    now = utc_now()
    settings = load_settings()
    warnings: List[str] = []
    out: Dict[str, Any] = {"generatedAt": iso_z(now), "halt": read_halt()}

    def safe(label: str, fn, default=None):
        try:
            return fn()
        except Exception as exc:
            warnings.append("%s unavailable: %s" % (label, str(exc)[:120]))
            return default

    run_scan = safe("runs", lambda: scan_runs(now), {"active": [], "newestMtime": None})
    events = safe("watchdog log", last_watchdog_events, [])
    queue = safe("queue", lambda: queue_summary(now), {"depth": 0, "claimed": 0, "dashboardRequests": 0, "unreadable": 0, "upNext": []})
    db = safe("database", lambda: cached("status-db:" + str(get_home()), 20.0, last_push_and_reed),
              {"lastPushAt": None, "lastPushSource": None, "reedRows": [], "dbOk": False, "dbError": "unavailable"})
    activity = safe("activity", lambda: last_activity(run_scan["newestMtime"], events))
    oh = settings["operating_hours"]
    inside = in_operating_hours(settings, now)
    activity_age = age_minutes(activity, now)
    active = run_scan["active"]
    stall = bool(
        inside and not out["halt"].get("halted") and not active and queue["depth"] > 0
        and (activity_age is None or activity_age > settings["stall_minutes"])
    )
    out["pipeline"] = {
        "inOperatingHours": inside, "operatingHours": "%02d:00-%02d:00" % (oh["start"], oh["end"]), "tz": oh["tz"],
        "lastActivityAt": iso_z(activity) if activity else None, "lastActivityAgeMinutes": activity_age,
        "stallSuspected": stall, "stallMinutes": settings["stall_minutes"],
    }
    out["activeRuns"] = active
    out["queue"] = queue
    out["caterer"] = safe("caterer state", lambda: caterer_state(events), {"state": "unknown"})
    out["reed"] = safe("reed state", lambda: reed_state(db["reedRows"]), {"state": "unknown"})
    push_dt = parse_iso(db["lastPushAt"]) if db.get("lastPushAt") else None
    out["lastPush"] = {"at": db.get("lastPushAt"), "ageMinutes": age_minutes(push_dt, now), "source": db.get("lastPushSource")}
    out["backup"] = safe("backup", lambda: backup_state(settings, now), {"stale": True, "lastAt": None})
    out["disk"] = safe("disk", lambda: disk_state(settings), {"available": False})
    out["alerts"] = safe("alerts", lambda: alerts_tail(15, now), {"tail": [], "critical24h": 0})
    out["db"] = {"ok": bool(db.get("dbOk")), "error": db.get("dbError")}
    if not db.get("dbOk"):
        warnings.append("candidates.db is not readable: %s" % db.get("dbError"))
    out["warnings"] = warnings
    return out


@router.get("/stats", response_model=None)
def stats(request: Request):
    settings = load_settings()
    now = utc_now()
    today = now.date()
    today_s = today.isoformat()
    warnings: List[str] = []
    try:
        con = ro_connect()
    except DbUnavailable as exc:
        return _db_error_response(exc)
    try:
        cands_cols = table_columns(con, "candidates")
        zoho = {"caterer": 0, "reed": 0, "unlockedCaterer": 0, "unlockedReed": 0}
        try:
            src = ("CASE WHEN LOWER(COALESCE(source,'caterer'))='reed' THEN 'reed' ELSE 'caterer' END"
                   if "source" in cands_cols else "'caterer'")
            for r in con.execute(
                "SELECT %s AS src, COUNT(*) AS total, SUM(CASE WHEN zoho_id IS NOT NULL THEN 1 ELSE 0 END) AS in_zoho, "
                "SUM(CASE WHEN unlocked = 1 THEN 1 ELSE 0 END) AS unlocked FROM candidates GROUP BY src" % src
            ).fetchall():
                zoho[r["src"]] = r["in_zoho"] or 0
                zoho["unlocked" + r["src"].capitalize()] = r["unlocked"] or 0
        except sqlite3.Error as exc:
            if not _is_missing_schema(exc):
                raise
            warnings.append("candidates table unavailable: %s" % exc)
        zoho_total = zoho["caterer"] + zoho["reed"]

        linked_today = None
        if "zoho_pushed_at" in cands_cols:
            row = con.execute(
                "SELECT COUNT(*) AS n FROM candidates WHERE zoho_pushed_at >= ? AND zoho_pushed_at < date(?, '+1 day')",
                (today_s, today_s)).fetchone()
            linked_today = row["n"] if row else 0

        terr = {"total": 0, "due": 0, "overdue": 0, "high": 0, "medium": 0, "low": 0}
        try:
            r = con.execute(
                "SELECT COUNT(*) AS total, "
                "SUM(CASE WHEN next_run_date IS NULL OR next_run_date <= :t THEN 1 ELSE 0 END) AS due, "
                "SUM(CASE WHEN next_run_date < :t THEN 1 ELSE 0 END) AS overdue, "
                "SUM(CASE WHEN priority='high' THEN 1 ELSE 0 END) AS high, "
                "SUM(CASE WHEN priority='medium' THEN 1 ELSE 0 END) AS medium, "
                "SUM(CASE WHEN priority='low' THEN 1 ELSE 0 END) AS low "
                "FROM territory_searches WHERE enabled = 1", {"t": today_s}).fetchone()
            terr = {k: (r[k] or 0) for k in terr}
        except sqlite3.Error as exc:
            if not _is_missing_schema(exc):
                raise
            warnings.append("territory_searches unavailable: %s" % exc)

        reed = {"date": today_s, "profileViews": 0, "dailyLimit": settings["reed_daily_limit"], "cvDownloads": 0,
                "remaining": settings["reed_daily_limit"], "expiry": settings["reed_expiry"]}
        try:
            r = con.execute("SELECT date, profile_views, cv_downloads, daily_limit FROM reed_daily_usage WHERE date = ?",
                            (today_s,)).fetchone()
            if r:
                limit = r["daily_limit"] or settings["reed_daily_limit"]
                reed.update(profileViews=r["profile_views"] or 0, cvDownloads=r["cv_downloads"] or 0, dailyLimit=limit,
                            remaining=max(0, limit - (r["profile_views"] or 0)))
        except sqlite3.Error as exc:
            if not _is_missing_schema(exc):
                raise
            warnings.append("reed_daily_usage unavailable: %s" % exc)

        rr_cols = table_columns(con, "run_results")
        need = {"date", "new_to_zoho", "downloaded", "duplicates", "errors"}
        quota: Dict[str, Any]
        if need.issubset(rr_cols):
            r = con.execute(
                "SELECT COUNT(*) AS runs, COALESCE(SUM(new_to_zoho),0) AS n, COALESCE(SUM(downloaded),0) AS d, "
                "COALESCE(SUM(duplicates),0) AS dup, COALESCE(SUM(errors),0) AS e FROM run_results WHERE date = ?",
                (today_s,)).fetchone()
            w = con.execute(
                "SELECT COUNT(*) AS runs, COALESCE(SUM(new_to_zoho),0) AS n, COALESCE(SUM(downloaded),0) AS d "
                "FROM run_results WHERE date >= date(?, '-6 day') AND date <= ?", (today_s, today_s)).fetchone()
            rows = con.execute(
                "SELECT date, SUM(new_to_zoho) AS n, SUM(downloaded) AS d, COUNT(*) AS runs FROM run_results "
                "WHERE date >= date(?, '-13 day') AND date <= ? GROUP BY date ORDER BY date", (today_s, today_s)).fetchall()
            by_day = {x["date"]: x for x in rows}
            series = []
            for i in range(13, -1, -1):
                day = (today - timedelta(days=i)).isoformat()
                x = by_day.get(day)
                series.append({"date": day, "new": (x["n"] or 0) if x else 0, "unlocked": (x["d"] or 0) if x else 0,
                               "runs": x["runs"] if x else 0})
            quota = {"source": "run_results", "todayNew": r["n"], "todayUnlocked": r["d"], "todayDuplicates": r["dup"],
                     "todayErrors": r["e"], "todayRuns": r["runs"], "weekNew": w["n"], "weekUnlocked": w["d"],
                     "weekRuns": w["runs"], "burnPerDay": round_half_up(w["n"] / 7.0), "series": series}
        else:
            warnings.append("run_results table is missing or incomplete; showing DB link counts (they include duplicates)")
            week_n = 0
            if "zoho_pushed_at" in cands_cols:
                w = con.execute("SELECT COUNT(*) AS n FROM candidates WHERE zoho_pushed_at >= date(?, '-6 day') "
                                "AND zoho_pushed_at < date(?, '+1 day')", (today_s, today_s)).fetchone()
                week_n = w["n"] if w else 0
            quota = {"source": "db-fallback", "todayNew": linked_today or 0, "todayUnlocked": None, "todayDuplicates": None,
                     "todayErrors": None, "todayRuns": None, "weekNew": week_n, "weekUnlocked": None, "weekRuns": None,
                     "burnPerDay": round_half_up(week_n / 7.0), "series": []}

        credits = _credits(con, settings, today, quota["burnPerDay"])
    except sqlite3.Error as exc:
        return _db_error_response(exc)
    finally:
        con.close()

    days_to_expiry = None
    per_day_needed = None
    try:
        days_to_expiry = (date.fromisoformat(settings["caterer_expiry"]) - today).days
        if days_to_expiry > 0:
            per_day_needed = -(-max(0, settings["zoho_goal"] - zoho_total) // days_to_expiry)
    except ValueError:
        pass
    pulled_today, pulled_week = quota["todayUnlocked"], quota["weekUnlocked"]
    targets = {
        "basis": "unlocked CVs (downloaded)", "perDay": settings["target_per_day"], "perWeek": settings["target_per_week"],
        "todayPulled": pulled_today, "weekPulled": pulled_week,
        "todayPercent": round(pulled_today * 100.0 / settings["target_per_day"], 1) if pulled_today is not None else None,
        "weekPercent": round(pulled_week * 100.0 / settings["target_per_week"], 1) if pulled_week is not None else None,
    }
    return {
        "generatedAt": iso_z(now), "today": today_s,
        "zoho": {"caterer": zoho["caterer"], "reed": zoho["reed"], "total": zoho_total, "goal": settings["zoho_goal"],
                 "percent": round(zoho_total * 100.0 / settings["zoho_goal"], 1),
                 "unlockedCaterer": zoho["unlockedCaterer"], "unlockedReed": zoho["unlockedReed"],
                 "daysToExpiry": days_to_expiry, "perDayNeeded": per_day_needed},
        "targets": targets, "quota": quota, "credits": credits, "reed": reed, "territories": terr,
        "linkedToZohoToday": linked_today, "warnings": warnings,
    }


def _credits(con: sqlite3.Connection, settings: Dict[str, Any], today: date, burn: int) -> Dict[str, Any]:
    remaining, synced_at, source = None, None, "default"
    for parts in (("credits-sync.json",), ("runtime", "credits-sync.json")):
        sync = read_json(*parts, default=None)
        value = sync.get("credits") if isinstance(sync, dict) else None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
            remaining, source = int(value), "sync"
            synced_at = sync.get("syncedAt") if isinstance(sync.get("syncedAt"), str) else None
            break
    if remaining is None:
        try:
            row = con.execute("SELECT credits_remaining FROM territory_searches WHERE credits_remaining IS NOT NULL "
                              "ORDER BY last_searched DESC LIMIT 1").fetchone()
            value = _to_int(row["credits_remaining"]) if row else None
            if value:
                remaining, source = value, "db"
        except sqlite3.Error:
            pass
    total = settings["caterer_credits_total"]
    if remaining is None:
        remaining = total
    runout = None
    if remaining > 0 and burn > 0:
        try:
            runout = (today + timedelta(days=remaining // burn)).isoformat()
        except OverflowError:
            runout = None
    return {"remaining": remaining, "total": total, "percentUsed": round_half_up((total - remaining) * 100.0 / total) if total else 0,
            "expiry": settings["caterer_expiry"], "syncedAt": synced_at, "source": source, "burnPerDay": burn,
            "projectedRunout": runout}


@router.get("/runs", response_model=None)
def runs(request: Request):
    limit = _qint(request, "limit", 20, 1, 100)
    offset = _qint(request, "offset", 0, 0, 100000)
    try:
        con = ro_connect()
    except DbUnavailable as exc:
        return _db_error_response(exc)
    warnings: List[str] = []
    try:
        cols = table_columns(con, "run_results")
        if not cols:
            return {"total": 0, "limit": limit, "offset": offset, "runs": [],
                    "warnings": ["run_results table is missing; history is empty until the migration has run"]}
        want = ["run_key", "date", "started_at", "completed_at", "phase1_started_at", "job_title", "location", "distance",
                "keywords", "sources", "pool", "downloaded", "new_to_zoho", "duplicates", "skipped", "errors", "approved_p1",
                "skipped_db", "skipped_review", "pages_scraped", "phase2_runtime_secs", "screening_model", "caterer_json",
                "reed_json"]
        have = [c for c in want if c in cols]
        order_cols = [c for c in ("completed_at", "started_at", "date") if c in cols]
        if len(order_cols) > 1:
            order_sql = "COALESCE(%s) DESC" % ", ".join(order_cols)
        elif order_cols:
            order_sql = "%s DESC" % order_cols[0]
        else:
            order_sql = "rowid DESC"
        if "run_key" in cols:
            order_sql += ", run_key DESC"
        total = con.execute("SELECT COUNT(*) AS n FROM run_results").fetchone()["n"]
        rows = con.execute("SELECT %s FROM run_results ORDER BY %s LIMIT ? OFFSET ?" % (", ".join(have), order_sql),
                           (limit, offset)).fetchall()
    except sqlite3.Error as exc:
        return _db_error_response(exc)
    finally:
        con.close()
    out = []
    for r in rows:
        d = {k: r[k] for k in have}
        started, done = parse_iso(d.get("phase1_started_at")), parse_iso(d.get("completed_at"))
        cat, reed_stats = source_breakdown(d.get("caterer_json")), source_breakdown(d.get("reed_json"))
        out.append({
            "runKey": d.get("run_key"), "date": d.get("date"), "startedAt": d.get("started_at"),
            "completedAt": d.get("completed_at"), "phase1StartedAt": d.get("phase1_started_at"),
            "jobTitle": scrub(d.get("job_title"), 80), "location": scrub(d.get("location"), 40), "distance": d.get("distance"),
            "keywords": scrub(d.get("keywords"), 60), "sources": d.get("sources"), "pool": d.get("pool"),
            "downloaded": d.get("downloaded"), "newToZoho": d.get("new_to_zoho"), "duplicates": d.get("duplicates"),
            "skipped": d.get("skipped"), "errors": d.get("errors"), "approvedP1": d.get("approved_p1"),
            "skippedDb": d.get("skipped_db"), "skippedReview": d.get("skipped_review"), "pagesScraped": d.get("pages_scraped"),
            "runSecs": int((done - started).total_seconds()) if started and done and done >= started else None,
            "screeningModel": scrub(d.get("screening_model"), 60) if d.get("screening_model") else None,
            "caterer": cat, "reed": reed_stats, "reedAuthFailed": bool(reed_stats and reed_stats.get("authFailed")),
        })
    return {"total": total, "limit": limit, "offset": offset, "runs": out, "warnings": warnings}


@router.get("/territories", response_model=None)
def territories(request: Request):
    q_title, q_loc = _qp(request, "q"), _qp(request, "loc")
    priority = _qp(request, "priority", max_len=10)
    if priority and priority not in VALID_PRIORITIES:
        return _err(400, "validation", "priority must be high, medium or low", field="priority")
    due_only = _qp(request, "due", max_len=1) == "1"
    enabled_only = _qp(request, "enabled", "1", max_len=1) != "0"
    exact = _qp(request, "exact", max_len=1) == "1"
    limit = _qint(request, "limit", 20, 1, 100)
    offset = _qint(request, "offset", 0, 0, 100000)
    today_s = utc_today()
    try:
        con = ro_connect()
    except DbUnavailable as exc:
        return _db_error_response(exc)
    try:
        cols = table_columns(con, "territory_searches")
        sources_sql = "COALESCE(sources,'caterer')" if "sources" in cols else "'caterer'"
        where: List[str] = ["1=1"]
        params: List[Any] = []
        if q_title:
            if exact:
                where.append("LOWER(job_title) = LOWER(?)")
                params.append(q_title)
            else:
                where.append("LOWER(job_title) LIKE '%' || LOWER(?) || '%' ESCAPE '!'")
                params.append(_like_escape(q_title))
        if q_loc:
            where.append("LOWER(location) LIKE '%' || LOWER(?) || '%' ESCAPE '!'")
            params.append(_like_escape(q_loc))
        if priority:
            where.append("priority = ?")
            params.append(priority)
        if enabled_only:
            where.append("enabled = 1")
        if due_only:
            where.append("(next_run_date IS NULL OR next_run_date <= ?)")
            params.append(today_s)
        where_sql = " AND ".join(where)
        total = con.execute("SELECT COUNT(*) AS n FROM territory_searches WHERE " + where_sql, params).fetchone()["n"]
        rows = con.execute(
            "SELECT id, job_title, location, distance, keywords, priority, enabled, %s AS sources, candidate_count, "
            "new_to_zoho, duplicates, skipped, errors, last_searched, next_run_date, "
            "CASE WHEN next_run_date IS NULL OR next_run_date <= ? THEN 1 ELSE 0 END AS is_due "
            "FROM territory_searches WHERE %s ORDER BY is_due DESC, next_run_date ASC, id ASC LIMIT ? OFFSET ?"
            % (sources_sql, where_sql), [today_s] + params + [limit, offset]).fetchall()
    except sqlite3.Error as exc:
        return _db_error_response(exc)
    finally:
        con.close()
    today = date.fromisoformat(today_s)
    out = []
    for r in rows:
        nxt = r["next_run_date"]
        try:
            days = (date.fromisoformat(nxt) - today).days if nxt else 0
        except ValueError:
            days = 0
        out.append({
            "id": r["id"], "jobTitle": scrub(r["job_title"], 80), "location": scrub(r["location"], 40),
            "distance": r["distance"], "keywords": scrub(r["keywords"], 60), "priority": r["priority"],
            "enabled": bool(r["enabled"]), "sources": r["sources"], "pool": r["candidate_count"],
            "newToZoho": r["new_to_zoho"], "duplicates": r["duplicates"], "skipped": r["skipped"], "errors": r["errors"],
            "lastSearched": r["last_searched"], "nextRunDate": nxt, "isDue": bool(r["is_due"]), "daysUntilDue": days,
        })
    return {"total": total, "limit": limit, "offset": offset, "today": today_s, "rows": out}


@router.get("/schedule", response_model=None)
def schedule(request: Request):
    days = _qint(request, "days", 7, 1, 30)
    per_group = _qint(request, "perGroup", 12, 1, 50)
    settings = load_settings()
    today_s = utc_today()
    today = date.fromisoformat(today_s)
    try:
        con = ro_connect()
    except DbUnavailable as exc:
        return _db_error_response(exc)
    try:
        cols = table_columns(con, "territory_searches")
        sources_sql = "COALESCE(sources,'caterer')" if "sources" in cols else "'caterer'"
        total_enabled = con.execute("SELECT COUNT(*) AS n FROM territory_searches WHERE enabled = 1").fetchone()["n"]
        total_due = con.execute("SELECT COUNT(*) AS n FROM territory_searches WHERE enabled = 1 AND "
                                "(next_run_date IS NULL OR next_run_date <= ?)", (today_s,)).fetchone()["n"]
        buckets = con.execute(
            "SELECT CASE WHEN next_run_date IS NULL THEN 'unscheduled' WHEN next_run_date < :t THEN 'overdue' "
            "ELSE next_run_date END AS bucket, COUNT(*) AS n FROM territory_searches WHERE enabled = 1 AND "
            "(next_run_date IS NULL OR next_run_date <= date(:t, '+' || :d || ' day')) GROUP BY bucket "
            "ORDER BY CASE bucket WHEN 'overdue' THEN 0 WHEN 'unscheduled' THEN 2 ELSE 1 END, bucket",
            {"t": today_s, "d": days}).fetchall()
        groups = []
        for b in buckets:
            key = b["bucket"]
            if key == "overdue":
                where, params, order = "next_run_date < ?", [today_s], "next_run_date ASC, "
                label = "Overdue"
            elif key == "unscheduled":
                where, params, order = "next_run_date IS NULL", [], ""
                label = "Unscheduled"
            else:
                where, params, order = "next_run_date = ?", [key], ""
                try:
                    label = _fmt_day(date.fromisoformat(key), today)
                except ValueError:
                    label = key
            rows = con.execute(
                "SELECT id, job_title, location, distance, keywords, priority, %s AS sources, last_searched, next_run_date "
                "FROM territory_searches WHERE enabled = 1 AND %s ORDER BY %sCASE priority WHEN 'high' THEN 0 "
                "WHEN 'medium' THEN 1 ELSE 2 END, id LIMIT ?" % (sources_sql, where, order), params + [per_group]).fetchall()
            groups.append({
                "key": key, "label": label, "count": b["n"], "truncated": b["n"] > len(rows),
                "rows": [{"id": r["id"], "jobTitle": scrub(r["job_title"], 80), "location": scrub(r["location"], 40),
                          "distance": r["distance"], "keywords": scrub(r["keywords"], 60), "priority": r["priority"],
                          "sources": r["sources"], "lastSearched": r["last_searched"], "nextRunDate": r["next_run_date"]}
                         for r in rows],
            })
    except sqlite3.Error as exc:
        return _db_error_response(exc)
    finally:
        con.close()
    oh = settings["operating_hours"]
    return {"today": today_s, "totalEnabled": total_enabled, "totalDue": total_due, "capPerDay": TERRITORY_DAILY_CAP,
            "queueCheck": "Due territories are queued automatically by the supervisor",
            "operatingHours": "%02d:00-%02d:00 %s" % (oh["start"], oh["end"], oh["tz"]), "groups": groups}


@router.post("/search", response_model=None)
async def post_search(request: Request):
    body, problem = await _read_json_body(request)
    if problem is not None:
        return problem
    try:
        status_code, payload = await run_in_threadpool(lambda: enqueue_search(body, load_settings(), actor=_actor(request)))
    except JailError as exc:
        return _err(400, "path_jail", str(exc))
    except TimeoutError as exc:
        return _err(503, "busy", str(exc), headers={"Retry-After": "2"})
    except OSError as exc:
        return _err(500, "write_failed", "could not queue the search: %s" % exc)
    return JSONResponse(status_code=status_code, content=payload)


@router.post("/halt/clear", response_model=None)
async def post_halt_clear(request: Request):
    _body, problem = await _read_json_body(request)
    if problem is not None:
        return problem
    actor = _actor(request)
    try:
        payload = await run_in_threadpool(clear_halt, actor)
    except JailError as exc:
        return _err(400, "path_jail", str(exc))
    except OSError as exc:
        return _err(500, "clear_failed", "could not clear the halt: %s" % exc)
    return payload


@router.get("/errors", response_model=None)
def errors(request: Request):
    settings = load_settings()
    limit = _qint(request, "limit", 50, 1, 100)
    entries = parse_jsonl(tail_lines("logs", "errors.jsonl", max_bytes=262144))
    ack = read_json("logs", "errors-acknowledged.json", default={})
    acked = ack.get("acknowledgedAt") if isinstance(ack, dict) and isinstance(ack.get("acknowledgedAt"), str) else None
    show_names = settings["show_candidate_names"]
    out = []
    for e in reversed(entries[-limit:]):
        ts = e.get("ts") if isinstance(e.get("ts"), str) else None
        item = {
            "ts": ts, "context": scrub(e.get("context"), 60), "severity": e.get("severity") if e.get("severity") in ("info", "warn", "critical") else None,
            "error": redact_name(scrub(e.get("error"), 2000), e.get("name"))[:300],
            "detail": redact_name(scrub(e.get("detail"), 2000), e.get("name"))[:300] if e.get("detail") else None,
            "jobTitle": scrub(e.get("jobTitle"), 80) if e.get("jobTitle") else None,
            "location": scrub(e.get("location"), 40) if e.get("location") else None,
            "read": bool(acked and ts and ts <= acked),
        }
        if show_names:
            item["name"] = scrub(e.get("name"), 80) if e.get("name") else None
        out.append(item)
    return {"errors": out, "acknowledgedAt": acked, "unread": sum(1 for i in out if not i["read"])}


@router.post("/errors/ack", response_model=None)
async def post_errors_ack(request: Request):
    _body, problem = await _read_json_body(request)
    if problem is not None:
        return problem

    def write() -> str:
        stamp = iso_z(utc_now())
        directory = jail_path("logs")
        directory.mkdir(parents=True, exist_ok=True)
        tmp = directory / (".errors-acknowledged.%s.tmp" % secrets.token_hex(4))
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o664)
        try:
            os.write(fd, json.dumps({"acknowledgedAt": stamp}).encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(str(tmp), str(directory / "errors-acknowledged.json"))
        return stamp

    try:
        stamp = await run_in_threadpool(write)
    except (OSError, JailError) as exc:
        return _err(500, "ack_failed", "could not record the acknowledgement: %s" % exc)
    return {"ok": True, "acknowledgedAt": stamp}
