# Resourcer on Hermes

This repository is the CV-sourcing pipeline of Chefs Bay, moved from a Windows laptop (OpenClaw, PowerShell, WSL, PM2, WhatsApp) to a Hermes Cloud profile named `resourcer` on Linux. It finds candidates on
Caterer.com and Reed.co.uk, screens them with AI (Claude through the Vercel AI Gateway, with the small model Jev running in shadow), unlocks and downloads the good ones and creates them in Zoho Recruit.
It runs from Hermes cron jobs with no human in the loop; an operator (an LLM following `hermes/AGENTS.md`) installs it, watches it and answers questions about it. The operator operates; it never edits code.

The behaviour, state-file schemas, exit codes and reliability layers of the old system were kept; every deliberate change is listed in `docs/DECISIONS.md`. Nothing here contains a secret or real candidate data:
secrets travel only in an encrypted data bundle (`data/resourcer-bundle.enc`, added at cutover) and live on the instance in `secrets/` and the profile `.env`.

## How to read it

1. `HANDOFF.md` - what was built, what state it is in, what the owner must do and decide, in order. Start here.
2. `docs/INSTALL.md` - the install runbook the operator follows (preflight, code, bundle, cron jobs, plugin, first run). Then `docs/ACCEPTANCE.md` (checks that need the real instance) and `docs/CUTOVER.md`.
3. `OPERATOR-PROMPT.md` - what to tell the operator agent to begin. Its standing instructions are `hermes/AGENTS.md`, `hermes/SOUL.md` and the skill `hermes/skills/resourcer-ops/SKILL.md`.
4. Day to day: `docs/OPERATIONS.md` (routine, alerts, recovery), `docs/KNOWN-LIMITS.md` (what is unverified or imperfect, with the mitigation), `docs/ROLLBACK.md`, `docs/TEARDOWN.md` (retiring the laptop).
5. Reference: `docs/ENV.md` (every setting), `docs/SCREENING.md` (how candidates are judged and how Jev is promoted), `docs/SECURITY.md` (secrets, personal data, encryption, data protection facts), `docs/DECISIONS.md`
   (owner decisions and every divergence from the old system), `docs/LEGACY-MAP.md` (old file to new file), `docs/DESIGN.md` (the binding contract), `docs/parity/*.md` (per-package detail with legacy line numbers, UNVERIFIED-LIVE lists).

## Layout

```
README.md  HANDOFF.md  OPERATOR-PROMPT.md  MANIFEST.sha256  .gitattributes (LF line endings)  .gitignore
docs/         INSTALL CUTOVER ROLLBACK OPERATIONS ACCEPTANCE TEARDOWN KNOWN-LIMITS DECISIONS SECURITY ENV LEGACY-MAP SCREENING DESIGN, parity/<package>.md
resourcer/    the workspace root (RESOURCER_HOME on the instance)
  candidates-db.js  package.json  config/  scripts/  scripts/lib/  scripts/lib/screening/  scripts/phase1/
  (created at run time, never committed: runs/ downloads/ logs/ runtime/ pending-searches/ secrets/ outbox/ shadow/ state/ backups/)
plugin/resourcer/   the dashboard plugin (manifest, FastAPI routes, one-file UI)
hermes/       profile files: AGENTS.md SOUL.md .env.example cron/jobs.json scripts/*.sh (cron wrappers) skills/resourcer-ops/SKILL.md
tools/        make-bundle.js restore-bundle.js verify-bundle.js (data bundle), make-manifest.js check-manifest.js (code lockdown),
              request-search.js, screening-report.js, preflight.sh (environment probes), install helpers
tests/        node --test suites per package (docs/ checks that the documents agree with the code and the manifest tools hold), fake servers, e2e/ scenarios, e2e-linux.sh
data/         resourcer-bundle.enc (encrypted; added at cutover; never plaintext)
```

## Running the tests

Requirements: Node 22 or later, `npm`, Linux for the process, permission and lock tests (Windows runs everything that is not POSIX-specific). The tests use fake browsers, a fake AI gateway, a fake Zoho and
temporary directories, refuse any network host but 127.0.0.1, and touch no live site and no real data. Use quoted globs: a bare directory argument fails on Node 22 and later.

```
cd resourcer && npm install                                 # better-sqlite3, mammoth, pdf-parse, ws
cd ..
node --test "tests/core/*.test.js"                          # one package: core, lifecycle, phase1, screening, supervision, reed, browser, bundle, dashboard, docs
NODE_PATH=$PWD/resourcer/node_modules RESOURCER_PYTHON=/path/to/venv/bin/python node --test "tests/**/*.test.js"    # everything
bash tests/e2e-linux.sh                                     # the 12 end-to-end scenarios on Linux (about 16 minutes)
```

Without `NODE_PATH` and a Python that has `fastapi`, `httpx` and `pytest`, about 36 tests skip themselves (backup, the real Phase 2, the dashboard plugin suites) because `better-sqlite3` sits in `resourcer/node_modules`; do
not trust a green run that skipped them. Four real-browser Reed tests skip unless `REED_REAL_CHROMIUM=<chromium binary>` is set. `bash tests/browser/smoke-linux.sh` and `sh tools/preflight.sh` are read-only checks
meant to be run on the instance itself. Last full run (2026-09-29, Linux, Node 22): about 1,600 tests, all passing apart from the 4 real-browser skips; 12 of 12 end-to-end scenarios passing. What the tests cannot prove
(live sites, the real Hermes host, Chromium 153, real Zoho) is listed as UNVERIFIED-LIVE in `docs/KNOWN-LIMITS.md` and turned into checks in `docs/ACCEPTANCE.md`.

## Rules for changing anything

- Read `docs/DESIGN.md` section 9: CommonJS, Node 22 or later, ASCII-only source, LF line endings, spawn with argument arrays, atomic writes for state files, every command has `--help`, no comments except a
  one-line reason, no secrets or real personal data anywhere. Hour-of-day logic always uses Europe/London.
- The code on the instance is locked. After an intended change, regenerate and commit the manifest as the last step: `node tools/make-manifest.js`; the instance then checks itself with `node tools/check-manifest.js`
  (docs/SECURITY.md section 4). Never edit files on the instance; make the change here, test it, and install again.
- New settings must be added to `docs/ENV.md` and, if a profile may hold them, to `hermes/.env.example`. New alert keys must be added to the table in `hermes/AGENTS.md`.
