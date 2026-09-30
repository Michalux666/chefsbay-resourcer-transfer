# Resourcer dashboard plugin

The Hermes dashboard tab that replaces the old Express dashboard: live progress of the run in flight, queue,
recent runs, territories and schedule, totals and today / 7-day counts against the 181 per day (1,269 per week)
pull target, the pipeline-halt banner with a clear button, a request-a-search form, and an alerts / errors feed.
It is a viewer plus three small writes. It never starts pipeline work and never writes to `candidates.db`.

```
plugin/resourcer/                 copied to /opt/data/plugins/resourcer/ (name == directory == manifest name)
  plugin.yaml                     agent-side manifest (required so `hermes plugins enable` can find the plugin)
  __init__.py                     no-op register(ctx) (required by the agent loader)
  install-plugin.sh               one-shot installer for the operator (copy, link, enable); run with bash
  dashboard/manifest.json         dashboard manifest (strict JSON, no comments)
  dashboard/plugin_api.py         FastAPI routes, one file, stdlib + fastapi only
  dashboard/dist/index.js         plain IIFE on window.__HERMES_PLUGIN_SDK__, no build step, no CDN
  dashboard/dist/style.css        theme variables only
```

Routes (all under `/api/plugins/resourcer/`, behind the Hermes dashboard login; no auth code of its own):

| Route | Purpose |
|---|---|
| `GET /health` | install smoke test; never raises, every check is a boolean |
| `GET /status` | halt, run in flight, queue, Caterer / Reed state, last push, backup age, disk, alerts tail |
| `GET /stats` | Zoho totals, today and 7-day counts, targets, credits, Reed usage, territory counts |
| `GET /runs`, `GET /territories`, `GET /schedule` | paged lists from the read-only database |
| `GET /halt`, `POST /halt/clear` | halt state and the manual clear (same file protocol as the pipeline's halt library) |
| `POST /search` | queue a one-off search as an atomic `pending-searches/search-*.json` drop |
| `GET /errors`, `POST /errors/ack` | error feed (candidate names, emails and phone numbers redacted) and acknowledge |

## Install (operator LLM: run exactly this, as the `hermes` user)

Preflight and on-box facts are in `docs/INSTALL.md`. The plugin lives at machine level, not in the profile.

```bash
bash <path of this repository checkout on the instance>/plugin/resourcer/install-plugin.sh
```

The script is a file, so it raises no approval prompt (no recursive delete, no `find -exec`, no heredoc in the command
line). It moves an older install aside to `/opt/data/plugins/resourcer.old-<UTC time>` (delete that copy later, by hand,
once the new one works), copies the plugin without bytecode caches, links it into the profile, enables it for the
default home and for the `resourcer` profile (falling back to Hermes' own config helpers when `hermes plugins enable`
is refused), and prints `INSTALL_OK`. Its steps are spelled out in "Enable" below for reference or a manual run.
Override `PLUGIN_DEST`, `PROFILE_PLUGINS_DIR`, `HERMES_BIN` and `HERMES_PYTHON` only for a non-standard layout.

## Enable

User plugins are off by default. The plugin must be listed in `plugins.enabled` of the default home
(`/opt/data/config.yaml`, decides API mount and asset serving) AND of the profile
(`/opt/data/profiles/resourcer/config.yaml`, decides whether the tab is listed while the profile switcher is on
`resourcer`). `install-plugin.sh` does the following; run these by hand only if it failed.

```bash
hermes plugins enable resourcer
mkdir -p /opt/data/profiles/resourcer/plugins
ln -sfn /opt/data/plugins/resourcer /opt/data/profiles/resourcer/plugins/resourcer
hermes -p resourcer plugins enable resourcer
hermes plugins list --enabled
```

If `hermes plugins enable` is refused, write the entry with Hermes' own config helpers (this is what Hermes'
own tests do; save the block below as a `.sh` file and run it with bash, because a heredoc typed on the command line
raises an approval prompt). `HERMES_PYTHON` is the interpreter named in the first line of the `hermes` launcher
(usually `/opt/hermes/.venv/bin/python`):

```bash
HERMES_PYTHON="$(head -1 "$(command -v hermes)" | sed 's/^#!//')"
for HOME_DIR in /opt/data /opt/data/profiles/resourcer; do
  HERMES_HOME="$HOME_DIR" "$HERMES_PYTHON" - <<'PY'
from hermes_cli.config import load_config, save_config
cfg = load_config()
plugins = cfg.setdefault("plugins", {})
enabled = plugins.get("enabled")
if not isinstance(enabled, list):
    enabled = []
if "resourcer" not in enabled:
    enabled.append("resourcer")
plugins["enabled"] = enabled
save_config(cfg)
print("enabled ->", plugins["enabled"])
PY
done
```

## Dashboard restart

`plugin_api.py` is imported once when the dashboard starts, so the first enable and every later change to that file
need a dashboard restart. Changes to `dist/index.js`, `dist/style.css` or `manifest.json` only need a browser reload
(open a fresh tab: the SPA caches the manifest list).

```bash
hermes dashboard --status
hermes dashboard --stop      # the dashboard supervisor restarts it; if it does not, use the Hermes Cloud portal restart
ls /opt/data/logs/errors.log
grep -E "Mounted plugin API routes: /api/plugins/resourcer/|Failed to load plugin resourcer" /opt/data/logs/errors.log | tail -3
```

`hermes dashboard --stop` also ends every Chat session that talks through the dashboard, including the operator's own:
ask the human to press Restart in the Hermes portal (or to run the command themselves) and to reopen the Chat tab
afterwards. The log lives under `/opt/data/logs/` (a container terminal's `~` is `<HERMES_HOME>/home`, not the dashboard's
home); if `ls` shows no such file, look for `errors.log` next to the dashboard's other logs before concluding anything.
Whether the dashboard can be restarted from the box on Hermes Cloud is UNVERIFIED-LIVE (see `docs/parity/dashboard.md`).

## Configure (all optional)

* `RESOURCER_HOME` (environment of the dashboard process) or, when you cannot set that, a file
  `/opt/data/plugins/resourcer/dashboard/plugin_config.json` containing `{"resourcerHome": "/opt/data/profiles/resourcer/workspace/resourcer"}`.
  Default: `/opt/data/profiles/resourcer/workspace/resourcer`. The plugin can only read and write below this directory.
* `config/dashboard-settings.json` inside `RESOURCER_HOME` overrides business constants. Missing or invalid keys
  fall back to the defaults: `zoho_goal` 100000, `caterer_credits_total` 62475, `caterer_expiry` 2027-03-11,
  `reed_expiry` 2027-03-18, `reed_daily_limit` 600, `target_per_day` 181, `target_per_week` 1269,
  `operating_hours` {start 6, end 22, tz Europe/London}, `location_mode` `outward` (or `any` to also accept a
  full postcode or a place name), `show_candidate_names` false, `stall_minutes` 20, `backup_stale_hours` 26,
  `disk_warn_pct` 75, `disk_critical_pct` 85.

## Verify (acceptance checks, none needs a live site)

1. Backend without going through dashboard auth (also proves the imports work on the dashboard interpreter). The
   check uses FastAPI's `TestClient`, which needs `httpx` in the Hermes interpreter; probe that first with
   `"$HERMES_PYTHON" -c 'import httpx'` (an ImportError only means this check cannot run, not that the plugin is broken; use check 2
   instead). Save the block as a `.sh` file and run it with bash:

```bash
HERMES_PYTHON="$(head -1 "$(command -v hermes)" | sed 's/^#!//')"
RESOURCER_HOME=/opt/data/profiles/resourcer/workspace/resourcer "$HERMES_PYTHON" - <<'PY'
import importlib.util, json, sys
from fastapi import FastAPI
from fastapi.testclient import TestClient
path = "/opt/data/plugins/resourcer/dashboard/plugin_api.py"
spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_resourcer", path)
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
app = FastAPI(); app.include_router(mod.router, prefix="/api/plugins/resourcer")
client = TestClient(app)
for p in ("/health", "/status", "/stats", "/runs", "/territories", "/schedule", "/errors", "/halt"):
    print(p, client.get("/api/plugins/resourcer" + p).status_code)
print(json.dumps(client.get("/api/plugins/resourcer/health").json(), indent=2))
PY
```

   Expect 200 on every route (503 on `/stats`, `/runs`, `/territories`, `/schedule` only if `candidates.db` is missing) and
   `"ok": true` with `dbOpen`, `runResultsTable` and `pendingDirWritable` true in the health output.

2. Through the dashboard: the tab list must contain "Resourcer"
   (`curl -s "http://127.0.0.1:9119/api/dashboard/plugins?profile=resourcer"` shows an entry named `resourcer`; this route is public).
   In the logged-in browser console: `window.__HERMES_PLUGIN_SDK__.fetchJSON("/api/plugins/resourcer/health").then(console.log)`
   must print `ok: true`. Then open the tab: the status strip, Live progress and Targets panels must fill within 5 seconds.

3. Search flow: `node tools/request-search.js --job "Chef" --location LS1 --dry-run` prints `VALID`; run it without `--dry-run`,
   confirm one `pending-searches/search-*.json` exists (valid JSON, `location` `LS1`, no `spawnedAt`), a second identical
   call exits 3, `node resourcer/scripts/pending-gate.js` names that file first, then delete the test file.

4. Halt flow: `node resourcer/scripts/pipeline-halt-cli.js set test test` shows the red banner within 5 seconds; the "Clear halt"
   button (with its confirmation) removes it and adds a `pipeline_resumed` line to `logs/errors.jsonl`.

## Roll back

```bash
hermes plugins disable resourcer
hermes -p resourcer plugins disable resourcer
rm /opt/data/profiles/resourcer/plugins/resourcer            # the link only; a plain rm needs no approval
mv /opt/data/plugins/resourcer /opt/data/plugins/resourcer.disabled
hermes dashboard --stop     # restart the dashboard so the routes are unmounted (see "Dashboard restart")
```

Nothing else is changed by the plugin, so there is nothing to undo in the workspace. Test files in
`pending-searches/` and lines in `logs/errors.jsonl` from the acceptance checks are harmless and can stay.

## Troubleshooting

| Symptom | Cause | Check |
|---|---|---|
| No "Resourcer" tab | not in `plugins.enabled` of the selected profile, manifest invalid, wrong directory depth | `curl -s "http://127.0.0.1:9119/api/dashboard/plugins?profile=resourcer"` |
| Tab says the plugin did not register | JS ran but the registered name differs from the manifest name | browser console; both must be `resourcer` |
| `/api/plugins/resourcer/...` returns 404 | not enabled in the default home config, or the dashboard was not restarted after enabling | grep the dashboard log (see above) |
| 401 from a plugin route | called with plain `fetch` instead of the SDK | use `SDK.fetchJSON` |
| 503 `db_unavailable` | `candidates.db` missing, locked, or a hot journal | retry in 5 seconds; `GET /health` shows `dbFile` and `dbOpen` |
| Panels say `run_results not available` | the schema migration has not created the table yet | run the migration, then reload |
| Search form answers 409 | the same title and location is already pending or running | it runs in queue order; nothing to do |
| Search form answers 429 `queue_full` | 25 manual searches (dashboard or `tools/request-search.js`) are already waiting; each spends paid credits | they run in queue order; try again later. Scheduled territories do not count |
| A POST answers 403 `cross_site` | the browser marked the request as coming from another site (`Sec-Fetch-Site`) | use the dashboard tab itself, not a page on another site |
| `/health` says `RESOURCER_HOME points at a machine-level directory` | the variable (or `plugin_config.json`) names `/opt/data` or another directory holding `profiles/` or `plugins/` | point it at the resourcer workspace, e.g. `/opt/data/profiles/resourcer/workspace/resourcer` |

## Security notes

The plugin runs inside the dashboard process with the dashboard's OS privileges, so its only fence is its own code.
Every path goes through one function that pins it to `RESOURCER_HOME` and refuses `..`, absolute paths, symlink
escapes and names such as `.env`, `*credentials*`, `*session*.json`, `secrets/` and `state/`. Routes return counts and
job titles only, never candidate names, emails, phone numbers or ids. Do not put secrets in `dist/` files: the dashboard
serves them to anyone who can open the tab.
