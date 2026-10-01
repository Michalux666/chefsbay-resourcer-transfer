/**
 * Resourcer dashboard plugin - plain IIFE, no build step, no external assets.
 * Talks only to /api/plugins/resourcer/* through the Hermes SDK (fetchJSON, or authedFetch as fallback).
 * Every value from the API is rendered as a React text child: no innerHTML, no data-built handlers or URLs.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG || !SDK.React || !SDK.hooks || typeof REG.register !== "function") {
    if (typeof console !== "undefined") console.warn("[resourcer] Hermes plugin SDK not present; is this the Hermes dashboard?");
    return;
  }

  var React = SDK.React;
  var h = React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef || function (initial) {
    var holder = useState({ current: initial });
    return holder[0];
  };

  var NAME = "resourcer";
  var API = "/api/plugins/" + NAME;
  var STATUS_MS = 5000;
  var STATS_MS = 30000;
  var LIST_MS = 60000;
  var BACKOFF_MS = 30000;
  var JSON_HEADERS = { "Content-Type": "application/json" };

  var DISTANCES = [5, 10, 20, 30, 40, 60, 80];
  var ACTIVE_WITHIN = ["14 days", "1 month", "2 months", "3 months", "6 months", "12 months", "18 months", "All"];
  var CV_LIMITS = [10, 20, 30, 40, 50];
  var SOURCES = [["both", "Both (Caterer + Reed)"], ["caterer", "Caterer only"], ["reed", "Reed only"]];
  var PRIORITIES = [["low", "Low - weekly"], ["medium", "Medium - every 3 days"], ["high", "High - every 2 days"]];
  var OUTWARD = /^[A-Z]{1,2}[0-9][0-9A-Z]?$/;
  var CITY_NAMES = ["london", "manchester", "leeds", "liverpool", "york", "york city", "sheffield", "birmingham", "bristol",
    "nottingham", "leicester", "newcastle", "glasgow", "edinburgh", "cardiff", "brighton", "oxford", "cambridge", "reading",
    "coventry", "hull", "bradford", "wolverhampton", "derby", "stoke", "exeter", "portsmouth", "southampton", "norwich",
    "plymouth", "sunderland", "middlesbrough", "bolton", "blackpool"];

  function call(path, init) {
    var url = API + path;
    if (typeof SDK.fetchJSON === "function") return SDK.fetchJSON(url, init);
    if (typeof SDK.authedFetch === "function") {
      return SDK.authedFetch(url, init).then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
          if (!res.ok) {
            var err = new Error((body && body.detail) || (res.status + ": request failed"));
            err.status = res.status;
            err.body = body;
            throw err;
          }
          return body;
        });
      });
    }
    return Promise.reject(new Error("The Hermes dashboard SDK has no fetch helper; reload the page."));
  }

  function postJSON(path, payload) {
    return call(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload || {}) });
  }

  // ApiError on current builds (.status/.body); "<status>: <raw body>" Error on older ones.
  function errInfo(e) {
    var info = { status: null, message: "request failed", body: null };
    if (!e) return info;
    info.message = String(e.message || e);
    info.status = typeof e.status === "number" ? e.status : null;
    var body = e.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (x) { body = null; }
    }
    if (!body || typeof body !== "object") {
      var m = /^(\d{3}):\s*(.*)$/.exec(info.message);
      if (m) {
        if (info.status === null) info.status = Number(m[1]);
        try { body = JSON.parse(m[2]); } catch (y) { body = null; }
      }
    }
    if (body && typeof body === "object") {
      info.body = body;
      if (typeof body.detail === "string") info.message = body.detail;
    }
    return info;
  }

  function isHidden() {
    return typeof document !== "undefined" && document.hidden === true;
  }

  // Poll a GET path while mounted and visible; back off after failures; 503 means "database busy".
  function usePoll(path, everyMs) {
    var s = useState({ data: null, error: null, loading: true, busy: false });
    var state = s[0], setState = s[1];
    var t = useState(0);
    var tick = t[0], setTick = t[1];
    useEffect(function () {
      var cancelled = false;
      var timer = null;
      function schedule(ms) {
        if (!cancelled) timer = setTimeout(run, ms);
      }
      function run() {
        if (cancelled) return;
        if (isHidden()) { schedule(everyMs); return; }
        call(path).then(function (data) {
          if (cancelled) return;
          setState({ data: data, error: null, loading: false, busy: false });
          schedule(everyMs);
        }, function (e) {
          if (cancelled) return;
          var info = errInfo(e);
          setState(function (prev) {
            return { data: prev.data, error: info.message, loading: false, busy: info.status === 503 };
          });
          schedule(Math.max(everyMs, BACKOFF_MS));
        });
      }
      run();
      return function () {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }, [path, everyMs, tick]);
    return { data: state.data, error: state.error, loading: state.loading, busy: state.busy, reload: function () { setTick(tick + 1); } };
  }

  function num(v) {
    if (v === null || v === undefined || v === "" || isNaN(Number(v))) return "-";
    return Number(v).toLocaleString("en-GB");
  }

  function pctText(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return "-";
    return Number(v).toFixed(0) + "%";
  }

  function when(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return d.toISOString();
    }
  }

  function day(iso) {
    if (!iso) return "-";
    var d = new Date(String(iso).slice(0, 10) + "T12:00:00Z");
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function ago(min) {
    if (min === null || min === undefined) return "-";
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    var hrs = Math.floor(min / 60);
    if (hrs < 48) return hrs + " h " + (min % 60) + " min ago";
    return Math.floor(hrs / 24) + " d ago";
  }

  function dur(secs) {
    if (secs === null || secs === undefined || isNaN(Number(secs))) return "-";
    var s = Math.max(0, Math.round(Number(secs)));
    var hrs = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60), sec = s % 60;
    if (hrs > 0) return hrs + "h " + min + "m";
    if (min > 0) return min + "m " + sec + "s";
    return sec + "s";
  }

  function bytes(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return "-";
    var gb = Number(v) / (1024 * 1024 * 1024);
    return gb >= 1 ? gb.toFixed(1) + " GB" : (Number(v) / (1024 * 1024)).toFixed(0) + " MB";
  }

  function clampPct(v) {
    var n = Number(v);
    if (isNaN(n) || n < 0) return 0;
    return n > 100 ? 100 : n;
  }

  function Card(props) {
    return h("section", { className: "rsr-card" + (props.className ? " " + props.className : "") },
      h("header", { className: "rsr-card-h" },
        h("h3", { className: "rsr-card-t" }, props.title),
        props.right ? h("div", { className: "rsr-card-r" }, props.right) : null),
      h("div", { className: "rsr-card-b" }, props.children));
  }

  function Chip(props) {
    var tone = { ok: "rsr-ok", warn: "rsr-warn", bad: "rsr-bad" }[props.tone] || "rsr-muted-chip";
    return h("div", { className: "rsr-chip " + tone, title: props.hint || null },
      h("span", { className: "rsr-chip-l" }, props.label),
      h("span", { className: "rsr-chip-v" }, props.value));
  }

  function Bar(props) {
    var p = clampPct(props.percent);
    return h("div", { className: "rsr-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(p) },
      h("div", { className: "rsr-bar-fill" + (props.tone ? " rsr-bar-" + props.tone : ""), style: { width: p + "%" } }));
  }

  function Stat(props) {
    return h("div", { className: "rsr-stat" },
      h("div", { className: "rsr-stat-v" }, props.value),
      h("div", { className: "rsr-stat-l" }, props.label));
  }

  function Notice(props) {
    if (!props.text) return null;
    return h("div", { className: "rsr-note " + (props.tone === "bad" ? "rsr-note-bad" : ""), role: props.tone === "bad" ? "alert" : "status" }, props.text);
  }

  function Elapsed(props) {
    var st = useState(Date.now());
    var now = st[0], setNow = st[1];
    useEffect(function () {
      var timer = setInterval(function () { setNow(Date.now()); }, 1000);
      return function () { clearInterval(timer); };
    }, []);
    var from = props.from ? Date.parse(props.from) : NaN;
    if (isNaN(from)) return h("span", { className: "rsr-muted" }, "-");
    return h("span", null, dur((now - from) / 1000));
  }

  function Pager(props) {
    var total = props.total || 0;
    var from = total === 0 ? 0 : props.offset + 1;
    var to = Math.min(total, props.offset + props.limit);
    return h("div", { className: "rsr-pager" },
      h("button", { type: "button", className: "rsr-btn", disabled: props.offset <= 0, onClick: function () { props.onPage(Math.max(0, props.offset - props.limit)); } }, "Prev"),
      h("span", { className: "rsr-muted" }, from + "-" + to + " of " + num(total)),
      h("button", { type: "button", className: "rsr-btn", disabled: to >= total, onClick: function () { props.onPage(props.offset + props.limit); } }, "Next"));
  }

  function HaltBanner(props) {
    var halt = props.halt;
    var st = useState({ confirming: false, busy: false, message: "", error: "" });
    var ui = st[0], setUi = st[1];
    var isHalted = !!(halt && halt.halted);
    useEffect(function () {
      if (!isHalted) setUi({ confirming: false, busy: false, message: "", error: "" });
    }, [isHalted]);
    if (!isHalted) return null;

    function clear() {
      setUi({ confirming: false, busy: true, message: "", error: "" });
      postJSON("/halt/clear", {}).then(function (res) {
        setUi({ confirming: false, busy: false, message: res && res.cleared ? "Halt cleared." : "Nothing to clear.", error: "" });
        if (props.onCleared) props.onCleared();
      }, function (e) {
        setUi({ confirming: false, busy: false, message: "", error: errInfo(e).message });
      });
    }

    var mins = halt.haltedForMinutes;
    var since = mins === null || mins === undefined ? "" : " for " + (mins < 60 ? mins + " min" : Math.floor(mins / 60) + "h " + (mins % 60) + "m");
    return h("div", { className: "rsr-halt", role: "alert" },
      h("div", { className: "rsr-halt-t" }, "PIPELINE STOPPED - " + (halt.reason || "unknown reason")),
      halt.detail ? h("div", { className: "rsr-halt-d" }, halt.detail) : null,
      halt.remedy ? h("pre", { className: "rsr-halt-r" }, halt.remedy) : null,
      h("div", { className: "rsr-halt-m" },
        "Stopped" + since + " - " + (halt.blockedRuns || 0) + " run(s) held back. Their territories were NOT consumed and run normally once this clears."),
      props.compact ? null : h("div", { className: "rsr-halt-a" },
        ui.confirming
          ? h("span", null,
            h("span", { className: "rsr-halt-q" }, "The watchdog halts again within a few minutes if screening is still failing. Clear the halt anyway? "),
            h("button", { type: "button", className: "rsr-btn rsr-btn-danger", disabled: ui.busy, onClick: clear }, "Yes, clear halt"),
            h("button", { type: "button", className: "rsr-btn", onClick: function () { setUi({ confirming: false, busy: false, message: "", error: "" }); } }, "Cancel"))
          : h("button", { type: "button", className: "rsr-btn rsr-btn-danger", disabled: ui.busy, onClick: function () { setUi({ confirming: true, busy: false, message: "", error: "" }); } }, "Clear halt"),
        ui.message ? h("span", { className: "rsr-muted" }, " " + ui.message) : null,
        ui.error ? h("span", { className: "rsr-err", role: "alert" }, " " + ui.error) : null));
  }

  function BannerSlot() {
    var poll = usePoll("/halt", 30000);
    return poll.data && poll.data.halted ? h(HaltBanner, { halt: poll.data, compact: true }) : null;
  }

  var CATERER_TEXT = {
    ok: ["ok", "Session OK"],
    relogin: ["warn", "Re-login attempted"],
    stale: ["bad", "Session stale"],
    safelist_blocked: ["bad", "Safe-list block"],
    login_failed: ["bad", "Login failed"],
    unknown: ["muted", "Unknown"]
  };
  var REED_TEXT = { ok: ["ok", "Auth OK"], auth_failed: ["bad", "Auth failed"], not_logged_in: ["warn", "Not logged in"], unknown: ["muted", "Unknown"], disabled: ["muted", "Disabled"] };

  function StatusStrip(props) {
    var s = props.status;
    if (!s) return null;
    var cat = CATERER_TEXT[s.caterer && s.caterer.state] || ["muted", (s.caterer && s.caterer.state) || "Unknown"];
    var reed = REED_TEXT[s.reed && s.reed.state] || ["muted", (s.reed && s.reed.state) || "Unknown"];
    var pipe = s.pipeline || {};
    var push = s.lastPush || {};
    var backup = s.backup || {};
    var disk = s.disk || {};
    var queue = s.queue || {};
    var pushTone = push.at ? (pipe.inOperatingHours && push.ageMinutes > 180 ? "warn" : "ok") : "muted";
    var stall = pipe.stallSuspected;
    return h("div", { className: "rsr-strip", "aria-live": "polite" },
      h(Chip, { label: "Caterer", value: cat[1], tone: cat[0], hint: (s.caterer && s.caterer.detail) || (s.caterer && s.caterer.source) || null }),
      h(Chip, { label: "Reed", value: reed[1], tone: reed[0], hint: (s.reed && s.reed.detail) || null }),
      h(Chip, { label: "Last push", value: push.at ? ago(push.ageMinutes) : "never", tone: pushTone, hint: push.at ? when(push.at) : null }),
      h(Chip, { label: "Queue", value: num(queue.depth) + (queue.claimed ? " (" + queue.claimed + " claimed)" : ""), tone: queue.depth > 0 ? "ok" : "muted" }),
      h(Chip, { label: "Activity", value: stall ? "None for " + ago(pipe.lastActivityAgeMinutes).replace(" ago", "") + ", work queued" : ago(pipe.lastActivityAgeMinutes), tone: stall ? "bad" : "ok" }),
      h(Chip, { label: "Hours", value: pipe.inOperatingHours ? "Running window" : "Outside window", tone: "muted", hint: (pipe.operatingHours || "") + " " + (pipe.tz || "") }),
      h(Chip, { label: "Backup", value: backup.lastAt ? (backup.ageHours + " h old") : "none found", tone: backup.stale ? "warn" : "ok", hint: backup.file || null }),
      h(Chip, { label: "Disk", value: disk.available ? pctText(disk.percentUsed) + " used" : "unknown", tone: disk.level === "critical" ? "bad" : disk.level === "warn" ? "warn" : disk.available ? "ok" : "muted", hint: disk.available ? bytes(disk.freeBytes) + " free" : null }));
  }

  function RunCard(props) {
    var run = props.run;
    var p1 = run.phase1, p2 = run.phase2;
    var done = p2 ? (p2.pushed || 0) + (p2.duplicates || 0) + (p2.errors || 0) : 0;
    var total = p2 && p2.total ? p2.total : 0;
    return h("div", { className: "rsr-run" + (run.stale ? " rsr-run-stale" : "") },
      h("div", { className: "rsr-run-top" },
        h("span", { className: "rsr-badge rsr-badge-" + (run.stage === "phase2" ? "p2" : "p1") }, run.label),
        h("span", { className: "rsr-run-title" }, run.jobTitle + " | " + run.location + " - " + num(run.distance) + "mi"),
        h("span", { className: "rsr-muted" }, run.sources),
        h("span", { className: "rsr-run-el" }, "elapsed ", h(Elapsed, { from: run.startedAt })),
        run.stale ? h("span", { className: "rsr-badge rsr-badge-warn", title: "No update for " + dur(run.idleSecs) }, "stale?") : null),
      p1 ? h("div", { className: "rsr-run-stats" },
        h(Stat, { label: "page", value: num(p1.page) }), h(Stat, { label: "pool", value: num(p1.pool) }),
        h(Stat, { label: "approved", value: num(p1.approved) }), h(Stat, { label: "skipped (db)", value: num(p1.skippedDb) }),
        h(Stat, { label: "errors", value: num(p1.errors) })) : null,
      p2 ? h("div", null,
        total ? h(Bar, { percent: total > 0 ? (done / total) * 100 : 0 }) : null,
        h("div", { className: "rsr-run-stats" },
          h(Stat, { label: "new", value: num(p2.pushed) }), h(Stat, { label: "duplicates", value: num(p2.duplicates) }),
          h(Stat, { label: "errors", value: num(p2.errors) }), h(Stat, { label: "done / total", value: num(done) + " / " + (total ? num(total) : "?") }))) : null);
  }

  function LiveCard(props) {
    var s = props.status;
    var runs = (s && s.activeRuns) || [];
    var queue = (s && s.queue) || { depth: 0, upNext: [] };
    var pipe = (s && s.pipeline) || {};
    return h(Card, { title: "Live progress", right: h("span", { className: "rsr-muted" }, runs.length ? runs.length + " running" : "idle") },
      !s ? h("div", { className: "rsr-muted" }, "Loading...") : null,
      s && runs.length === 0 ? h("div", { className: "rsr-idle" }, "No pipeline running.") : null,
      runs.map(function (r) { return h(RunCard, { key: r.file, run: r }); }),
      s ? h("div", { className: "rsr-queue" },
        h("div", { className: "rsr-queue-h" },
          "Queue: " + num(queue.depth) + " waiting" + (queue.claimed ? " (" + queue.claimed + " claimed)" : "") +
          (queue.dashboardRequests ? ", " + queue.dashboardRequests + " from the dashboard" : "") +
          ". Last activity: " + (pipe.lastActivityAt ? ago(pipe.lastActivityAgeMinutes) : "none seen")),
        queue.upNext && queue.upNext.length ? h("ol", { className: "rsr-upnext" },
          queue.upNext.map(function (q) {
            return h("li", { key: q.file }, q.jobTitle + " | " + q.location + (q.distance ? " - " + q.distance + "mi" : "") + (q.source === "dashboard" ? " (dashboard request)" : ""));
          })) : null) : null);
  }

  function Targets(props) {
    var st = props.stats;
    if (!st) return h(Card, { title: "Targets and totals" }, h("div", { className: "rsr-muted" }, "Loading..."));
    var q = st.quota || {}, tg = st.targets || {}, z = st.zoho || {}, c = st.credits || {}, r = st.reed || {}, t = st.territories || {};
    var series = q.series || [];
    var maxUnlocked = 1;
    series.forEach(function (d) { if (d.unlocked > maxUnlocked) maxUnlocked = d.unlocked; });
    var fallback = q.source !== "run_results";
    return h(Card, { title: "Targets and totals", right: h("span", { className: "rsr-muted" }, "UTC day " + st.today) },
      (st.warnings || []).map(function (w, i) { return h(Notice, { key: "w" + i, text: w }); }),
      h("div", { className: "rsr-grid" },
        h("div", { className: "rsr-block" },
          h("div", { className: "rsr-block-t" }, "Pulled today (target " + num(tg.perDay) + "/day)"),
          h("div", { className: "rsr-big" }, fallback ? "-" : num(tg.todayPulled)),
          fallback ? null : h(Bar, { percent: tg.todayPercent, tone: tg.todayPercent >= 100 ? "ok" : null }),
          h("div", { className: "rsr-muted" }, fallback ? "run_results not available" : pctText(tg.todayPercent) + " of target"),
          h("div", { className: "rsr-line" }, "New to Zoho " + num(q.todayNew) + " | duplicates " + num(q.todayDuplicates) + " | errors " + num(q.todayErrors) + " | runs " + num(q.todayRuns))),
        h("div", { className: "rsr-block" },
          h("div", { className: "rsr-block-t" }, "Last 7 days (target " + num(tg.perWeek) + "/week)"),
          h("div", { className: "rsr-big" }, fallback ? "-" : num(tg.weekPulled)),
          fallback ? null : h(Bar, { percent: tg.weekPercent, tone: tg.weekPercent >= 100 ? "ok" : null }),
          h("div", { className: "rsr-muted" }, fallback ? "-" : pctText(tg.weekPercent) + " of target"),
          h("div", { className: "rsr-line" }, "New to Zoho " + num(q.weekNew) + " | runs " + num(q.weekRuns) + " | ~" + num(q.burnPerDay) + " new/day")),
        h("div", { className: "rsr-block" },
          h("div", { className: "rsr-block-t" }, "In Zoho (goal " + num(z.goal) + ")"),
          h("div", { className: "rsr-big" }, num(z.total)),
          h(Bar, { percent: z.percent }),
          h("div", { className: "rsr-line" }, "Caterer " + num(z.caterer) + " | Reed " + num(z.reed)),
          h("div", { className: "rsr-muted" }, z.perDayNeeded ? "Needs ~" + num(z.perDayNeeded) + "/day until " + (c.expiry || "expiry") : "")),
        h("div", { className: "rsr-block" },
          h("div", { className: "rsr-block-t" }, "Credits"),
          h("div", { className: "rsr-big" }, num(c.remaining)),
          h("div", { className: "rsr-line" }, "of " + num(c.total) + " | expires " + (c.expiry || "-")),
          h("div", { className: "rsr-muted" }, (c.projectedRunout ? "Runout ~" + c.projectedRunout + ". " : "") + (c.syncedAt ? "Synced " + when(c.syncedAt) : "Not synced (" + (c.source || "default") + ")")),
          h("div", { className: "rsr-line" }, "Reed today " + num(r.profileViews) + " / " + num(r.dailyLimit) + " views")),
        h("div", { className: "rsr-block" },
          h("div", { className: "rsr-block-t" }, "Territories"),
          h("div", { className: "rsr-big" }, num(t.total)),
          h("div", { className: "rsr-line" }, num(t.due) + " due (" + num(t.overdue) + " overdue)"),
          h("div", { className: "rsr-muted" }, num(t.high) + " high | " + num(t.medium) + " medium | " + num(t.low) + " low"))),
      series.length ? h("div", { className: "rsr-series", role: "img", "aria-label": "Unlocked CVs per day, last 14 days" },
        series.map(function (d) {
          return h("div", { key: d.date, className: "rsr-series-col", title: d.date + ": " + d.unlocked + " pulled, " + d.new + " new, " + d.runs + " runs" },
            h("div", { className: "rsr-series-bar", style: { height: Math.max(2, Math.round((d.unlocked / maxUnlocked) * 100)) + "%" } }),
            h("div", { className: "rsr-series-l" }, String(d.date).slice(8)));
        })) : null);
  }

  function locHint(value) {
    var v = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
    if (!v) return null;
    if (OUTWARD.test(v)) return { ok: true, text: "Valid postcode area" };
    if (CITY_NAMES.indexOf(v.toLowerCase()) >= 0) return { ok: false, text: "City names resolve ambiguously - use the postcode area, e.g. M1, YO1, LS1." };
    if (v.length >= 4) return { ok: false, text: "Use the outward code only, e.g. YO2, LS1, NE1." };
    return null;
  }

  function Field(props) {
    return h("div", { className: "rsr-field" },
      h("label", { htmlFor: props.id, className: "rsr-label" }, props.label),
      props.children,
      props.hint ? h("div", { className: "rsr-hint" + (props.hint.ok === false ? " rsr-hint-bad" : props.hint.ok ? " rsr-hint-ok" : "") }, props.hint.text) : null);
  }

  function SelectField(props) {
    return h("select", { id: props.id, className: "rsr-input", value: props.value, onChange: function (e) { props.onChange(e.target.value); } },
      props.options.map(function (o) {
        var value = Array.isArray(o) ? o[0] : o;
        var label = Array.isArray(o) ? o[1] : String(o) + (props.suffix || "");
        return h("option", { key: String(value), value: String(value) }, label);
      }));
  }

  function SearchForm(props) {
    var init = { title: "", loc: "", kw: "", source: "both", priority: "high", distance: "20", active: "1 month", cv: "20" };
    var st = useState(init);
    var f = st[0], setF = st[1];
    var rs = useState({ busy: false, result: null, error: null, fieldError: null, existing: null });
    var ui = rs[0], setUi = rs[1];
    var last = useRef(0);

    useEffect(function () {
      if (props.prefill && props.prefill.n !== last.current) {
        last.current = props.prefill.n;
        var p = props.prefill;
        setF({ title: p.jobTitle || "", loc: p.location || "", kw: p.keywords || "", source: p.sources || "both", priority: "high",
          distance: String(p.distance || 20), active: "1 month", cv: "20" });
        setUi({ busy: false, result: null, error: null, fieldError: null, existing: null });
      }
    }, [props.prefill]);

    function set(key) {
      return function (value) {
        var next = {};
        for (var k in f) next[k] = f[k];
        next[key] = value;
        setF(next);
      };
    }

    function submit(e) {
      if (e && e.preventDefault) e.preventDefault();
      if (ui.busy) return;
      if (!f.title.trim() || !f.loc.trim()) {
        setUi({ busy: false, result: null, error: "Job title and postcode area are required.", fieldError: !f.title.trim() ? "jobTitle" : "location", existing: null });
        return;
      }
      setUi({ busy: true, result: null, error: null, fieldError: null, existing: null });
      postJSON("/search", {
        jobTitle: f.title, location: f.loc, keywords: f.kw, sources: f.source, priority: f.priority,
        distance: Number(f.distance), activeWithin: f.active, cvLimit: Number(f.cv)
      }).then(function (res) {
        setUi({ busy: false, result: res, error: null, fieldError: null, existing: null });
        setF({ title: "", loc: "", kw: "", source: f.source, priority: f.priority, distance: f.distance, active: f.active, cv: f.cv });
        if (props.onQueued) props.onQueued();
      }, function (err) {
        var info = errInfo(err);
        var body = info.body || {};
        setUi({ busy: false, result: null, error: info.message, fieldError: body.field || null, existing: info.status === 409 ? (body.existing || {}) : null });
      });
    }

    var hint = locHint(f.loc);
    var fe = ui.fieldError;
    return h(Card, { title: "Request a search" },
      h("form", { className: "rsr-form", onSubmit: submit, noValidate: true },
        h("div", { className: "rsr-form-grid" },
          h(Field, { id: "rsr-title", label: "Job title *" },
            h("input", { id: "rsr-title", className: "rsr-input" + (fe === "jobTitle" ? " rsr-input-bad" : ""), type: "text", maxLength: 60, placeholder: "Chef, Sous Chef, Kitchen Porter", value: f.title, onChange: function (e) { set("title")(e.target.value); } })),
          h(Field, { id: "rsr-loc", label: "Postcode area *", hint: hint },
            h("input", { id: "rsr-loc", className: "rsr-input" + (fe === "location" ? " rsr-input-bad" : ""), type: "text", maxLength: 12, autoComplete: "off", placeholder: "e.g. YO2, M1, LS1", value: f.loc, onChange: function (e) { set("loc")(e.target.value); } })),
          h(Field, { id: "rsr-kw", label: "Keywords (optional)" },
            h("input", { id: "rsr-kw", className: "rsr-input" + (fe === "keywords" ? " rsr-input-bad" : ""), type: "text", maxLength: 120, placeholder: "DBS, NVQ - only when needed", value: f.kw, onChange: function (e) { set("kw")(e.target.value); } })),
          h(Field, { id: "rsr-source", label: "Data source" }, h(SelectField, { id: "rsr-source", value: f.source, options: SOURCES, onChange: set("source") })),
          h(Field, { id: "rsr-priority", label: "Priority (sets the re-search schedule)" }, h(SelectField, { id: "rsr-priority", value: f.priority, options: PRIORITIES, onChange: set("priority") })),
          h(Field, { id: "rsr-distance", label: "Distance" }, h(SelectField, { id: "rsr-distance", value: f.distance, options: DISTANCES, suffix: " miles", onChange: set("distance") })),
          h(Field, { id: "rsr-active", label: "Active within" }, h(SelectField, { id: "rsr-active", value: f.active, options: ACTIVE_WITHIN, onChange: set("active") })),
          h(Field, { id: "rsr-cv", label: "CVs per run" }, h(SelectField, { id: "rsr-cv", value: f.cv, options: CV_LIMITS, suffix: " CVs", onChange: set("cv") }))),
        h("div", { className: "rsr-muted rsr-form-note" }, "Reed is used only when the pipeline has Reed enabled. A dashboard request runs ahead of scheduled territories."),
        h("div", { className: "rsr-form-actions" },
          h("button", { type: "submit", className: "rsr-btn rsr-btn-primary", disabled: ui.busy }, ui.busy ? "Queuing..." : "Queue search")),
        ui.error ? h(Notice, { tone: "bad", text: ui.error }) : null,
        ui.existing ? h("div", { className: "rsr-muted" },
          "Existing request: " + (ui.existing.jobTitle || "") + " | " + (ui.existing.location || "") + (ui.existing.distance ? " - " + ui.existing.distance + "mi" : "") +
          (ui.existing.where === "in_flight" ? " (running now)" : ui.existing.claimed ? " (picked up)" : " (waiting in the queue)")) : null,
        ui.result ? h(Notice, { text: "Queued " + ui.result.request.jobTitle + " | " + ui.result.request.location + " (position " + (ui.result.position || "?") + ", queue depth " + ui.result.queueDepthAfter + "). " + ui.result.note }) : null));
  }

  function StatsRow(props) {
    var s = props.stats;
    if (!s) return null;
    if (s.failed) {
      return h("div", { className: "rsr-src-row" },
        h("span", { className: "rsr-src-l" }, props.label),
        h("span", null, "not searched: " + (s.failureReason || "the search failed") + " | err " + num(s.errors)),
        h("span", { className: "rsr-badge rsr-badge-warn" }, "failed"));
    }
    return h("div", { className: "rsr-src-row" },
      h("span", { className: "rsr-src-l" }, props.label),
      h("span", null, "pool " + num(s.pool) + " | approved " + num(s.phase1 && s.phase1.approved) + " | new " + num(s.newToZoho) + " | dup " + num(s.duplicates) + " | err " + num(s.errors)),
      s.authFailed ? h("span", { className: "rsr-badge rsr-badge-warn" }, "auth failed") : null);
  }

  function RunsCard() {
    var st = useState(0);
    var offset = st[0], setOffset = st[1];
    var limit = 10;
    var poll = usePoll("/runs?limit=" + limit + "&offset=" + offset, LIST_MS);
    var d = poll.data;
    return h(Card, { title: "Recent runs", right: d ? h(Pager, { total: d.total, offset: offset, limit: limit, onPage: setOffset }) : null },
      poll.busy ? h(Notice, { text: "Database busy, retrying..." }) : poll.error && !d ? h(Notice, { tone: "bad", text: poll.error }) : null,
      d && d.warnings && d.warnings.length ? d.warnings.map(function (w, i) { return h(Notice, { key: "w" + i, text: w }); }) : null,
      d && d.runs.length === 0 ? h("div", { className: "rsr-muted" }, "No runs recorded yet.") : null,
      d ? d.runs.map(function (r) {
        var reedFailed = !!(r.reed && r.reed.failed);
        var bad = (r.errors || 0) > 0;
        return h("div", { key: r.runKey || (r.completedAt + r.location), className: "rsr-hist" },
          h("div", { className: "rsr-hist-top" },
            h("span", { className: "rsr-run-title" }, r.jobTitle + " | " + r.location + " - " + num(r.distance) + "mi" + (r.keywords ? " +" + r.keywords : "")),
            h("span", { className: "rsr-muted" }, r.sources || ""),
            h("span", { className: "rsr-muted" }, when(r.completedAt || r.startedAt)),
            h("span", { className: "rsr-muted" }, dur(r.runSecs)),
            h("span", { className: "rsr-badge " + (bad || reedFailed ? "rsr-badge-warn" : "rsr-badge-ok") }, bad ? num(r.errors) + " errors" : reedFailed ? (r.sources === "reed" ? "Finished" : "Caterer OK") : "OK"),
            r.reedAuthFailed ? h("span", { className: "rsr-badge rsr-badge-warn" }, "Reed auth failed") : null,
            reedFailed ? h("span", { className: "rsr-badge rsr-badge-warn" }, "Reed failed") : null),
          h("div", { className: "rsr-hist-stats" },
            h(Stat, { label: "pool", value: num(r.pool) }), h(Stat, { label: "unlocked", value: num(r.downloaded) }),
            h(Stat, { label: "new to Zoho", value: num(r.newToZoho) }), h(Stat, { label: "duplicates", value: num(r.duplicates) }),
            h(Stat, { label: "approved P1", value: num(r.approvedP1) }), h(Stat, { label: "skipped (db)", value: num(r.skippedDb) }),
            h(Stat, { label: "rejected", value: num(r.skippedReview) }), h(Stat, { label: "pages", value: num(r.pagesScraped) })),
          r.sources === "both" ? h("div", null, h(StatsRow, { label: "Caterer", stats: r.caterer }), h(StatsRow, { label: "Reed", stats: r.reed })) : null);
      }) : null);
  }

  function useDebounced(value, ms) {
    var st = useState(value);
    var debounced = st[0], setDebounced = st[1];
    useEffect(function () {
      var timer = setTimeout(function () { setDebounced(value); }, ms);
      return function () { clearTimeout(timer); };
    }, [value, ms]);
    return debounced;
  }

  function encodeQuery(obj) {
    var parts = [];
    for (var k in obj) {
      if (obj[k] !== "" && obj[k] !== null && obj[k] !== undefined) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  function TerritoriesCard(props) {
    var fs = useState({ q: "", loc: "", priority: "", due: false });
    var filters = fs[0], setFilters = fs[1];
    var os = useState(0);
    var offset = os[0], setOffset = os[1];
    var limit = 20;
    var debounced = useDebounced(filters, 300);
    var path = "/territories" + encodeQuery({ q: debounced.q, loc: debounced.loc, priority: debounced.priority, due: debounced.due ? "1" : "", limit: limit, offset: offset });
    var poll = usePoll(path, LIST_MS);
    var sched = usePoll("/schedule?days=7&perGroup=8", LIST_MS);
    var d = poll.data;

    function update(key) {
      return function (value) {
        var next = { q: filters.q, loc: filters.loc, priority: filters.priority, due: filters.due };
        next[key] = value;
        setFilters(next);
        setOffset(0);
      };
    }

    return h(Card, { title: "Territories and schedule", right: d ? h(Pager, { total: d.total, offset: offset, limit: limit, onPage: setOffset }) : null },
      h("div", { className: "rsr-filters" },
        h("input", { className: "rsr-input", type: "text", "aria-label": "Filter by role", placeholder: "Role", maxLength: 60, value: filters.q, onChange: function (e) { update("q")(e.target.value); } }),
        h("input", { className: "rsr-input", type: "text", "aria-label": "Filter by postcode", placeholder: "Postcode", maxLength: 12, value: filters.loc, onChange: function (e) { update("loc")(e.target.value); } }),
        h("select", { className: "rsr-input", "aria-label": "Filter by priority", value: filters.priority, onChange: function (e) { update("priority")(e.target.value); } },
          h("option", { value: "" }, "Any priority"), h("option", { value: "high" }, "High"), h("option", { value: "medium" }, "Medium"), h("option", { value: "low" }, "Low")),
        h("label", { className: "rsr-check" },
          h("input", { type: "checkbox", checked: filters.due, onChange: function (e) { update("due")(!!e.target.checked); } }), " Due only")),
      poll.busy ? h(Notice, { text: "Database busy, retrying..." }) : poll.error && !d ? h(Notice, { tone: "bad", text: poll.error }) : null,
      d ? h("div", { className: "rsr-scroll" },
        h("table", { className: "rsr-table" },
          h("thead", null, h("tr", null, ["Role", "Location", "Source", "Dist", "Priority", "Last run", "Next run", "New", "Pool", ""].map(function (c, i) { return h("th", { key: i }, c); }))),
          h("tbody", null, d.rows.map(function (r) {
            return h("tr", { key: r.id, className: r.enabled ? "" : "rsr-paused" },
              h("td", null, r.jobTitle + (r.keywords ? " +" + r.keywords : "")),
              h("td", null, r.location), h("td", null, r.sources), h("td", null, num(r.distance) + "mi"), h("td", null, r.priority),
              h("td", null, r.lastSearched ? day(r.lastSearched) : "never"),
              h("td", null, r.nextRunDate ? day(r.nextRunDate) : "-", r.isDue ? h("span", { className: "rsr-badge rsr-badge-warn" }, "DUE") : null),
              h("td", null, num(r.newToZoho)), h("td", null, num(r.pool)),
              h("td", null, h("button", { type: "button", className: "rsr-btn", onClick: function () { props.onPrefill({ jobTitle: r.jobTitle, location: r.location, keywords: r.keywords, sources: r.sources, distance: r.distance }); } }, "Run now")));
          })))) : null,
      d && d.rows.length === 0 ? h("div", { className: "rsr-muted" }, "No territories match.") : null,
      sched.data ? h("div", { className: "rsr-sched" },
        h("div", { className: "rsr-block-t" }, "Schedule - " + num(sched.data.totalDue) + " due of " + num(sched.data.totalEnabled) + " enabled. " + sched.data.queueCheck + ". Runs " + sched.data.operatingHours + "."),
        sched.data.groups.map(function (g) {
          return h("details", { key: g.key, className: "rsr-group", open: g.key === "overdue" || g.label === "Due today" },
            h("summary", null, g.label + " (" + num(g.count) + ")"),
            h("ul", { className: "rsr-group-list" },
              g.rows.map(function (r) { return h("li", { key: r.id }, r.jobTitle + " | " + r.location + " - " + num(r.distance) + "mi (" + r.priority + ", " + r.sources + ")"); }),
              g.truncated ? h("li", { className: "rsr-muted" }, "+" + num(g.count - g.rows.length) + " more") : null));
        })) : null);
  }

  function ErrorsCard(props) {
    var poll = usePoll("/errors?limit=30", LIST_MS);
    var st = useState({ busy: false, error: "" });
    var ui = st[0], setUi = st[1];
    var d = poll.data;
    var alerts = (props.status && props.status.alerts) || { tail: [], critical24h: 0 };

    function ack() {
      setUi({ busy: true, error: "" });
      postJSON("/errors/ack", {}).then(function () {
        setUi({ busy: false, error: "" });
        poll.reload();
      }, function (e) { setUi({ busy: false, error: errInfo(e).message }); });
    }

    return h(Card, { title: "Alerts and errors", right: d ? h("button", { type: "button", className: "rsr-btn", disabled: ui.busy || d.unread === 0, onClick: ack }, "Mark all read (" + d.unread + ")") : null },
      ui.error ? h(Notice, { tone: "bad", text: ui.error }) : null,
      h("div", { className: "rsr-block-t" }, "Recent alerts" + (alerts.critical24h ? " - " + alerts.critical24h + " critical in 24h" : "")),
      alerts.tail.length === 0 ? h("div", { className: "rsr-muted" }, "No alerts.") : h("ul", { className: "rsr-list" },
        alerts.tail.map(function (a, i) {
          return h("li", { key: i, className: "rsr-sev-" + a.severity }, h("span", { className: "rsr-muted" }, when(a.ts) + " "), a.text);
        })),
      h("div", { className: "rsr-block-t" }, "Error log"),
      !d ? h("div", { className: "rsr-muted" }, poll.error || "Loading...") : d.errors.length === 0 ? h("div", { className: "rsr-muted" }, "No errors logged.") : h("ul", { className: "rsr-list" },
        d.errors.map(function (e, i) {
          return h("li", { key: i, className: e.read ? "rsr-read" : "" },
            h("span", { className: "rsr-muted" }, when(e.ts) + " "), h("span", { className: "rsr-badge" }, e.context || "log"), " " + e.error +
            (e.jobTitle ? " (" + e.jobTitle + (e.location ? " | " + e.location : "") + ")" : ""));
        })));
  }

  function ResourcerPage() {
    var status = usePoll("/status", STATUS_MS);
    var stats = usePoll("/stats", STATS_MS);
    var pf = useState({ n: 0 });
    var prefill = pf[0], setPrefill = pf[1];
    var s = status.data;

    function doPrefill(values) {
      var next = { n: prefill.n + 1 };
      for (var k in values) next[k] = values[k];
      setPrefill(next);
      if (typeof document !== "undefined" && document.getElementById) {
        var el = document.getElementById("rsr-search");
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    return h("div", { className: "rsr-page" },
      status.error && !s ? h(Notice, { tone: "bad", text: "Could not load status: " + status.error }) : null,
      s ? h(HaltBanner, { halt: s.halt, onCleared: status.reload }) : null,
      s && s.warnings && s.warnings.length ? s.warnings.map(function (w, i) { return h(Notice, { key: "sw" + i, text: w }); }) : null,
      h(StatusStrip, { status: s }),
      h(LiveCard, { status: s }),
      stats.busy ? h(Notice, { text: "Database busy, retrying..." }) : null,
      h(Targets, { stats: stats.data }),
      h("div", { id: "rsr-search" }, h(SearchForm, { prefill: prefill, onQueued: function () { status.reload(); } })),
      h(RunsCard, null),
      h(TerritoriesCard, { onPrefill: doPrefill }),
      h(ErrorsCard, { status: s }));
  }

  REG.register(NAME, ResourcerPage);
  if (typeof REG.registerSlot === "function") {
    try {
      REG.registerSlot(NAME, "header-banner", BannerSlot);
    } catch (e) {
      if (typeof console !== "undefined") console.warn("[resourcer] header-banner slot not available", e);
    }
  }
})();
