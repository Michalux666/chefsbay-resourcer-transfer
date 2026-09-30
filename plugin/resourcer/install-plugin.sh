#!/usr/bin/env bash
# Installs the resourcer dashboard plugin at machine level and enables it for the default home and the
# resourcer profile. Run it as a file (bash install-plugin.sh): no recursive delete, no find -exec, no heredoc
# in the command line, so it raises no approval prompt. An older install is moved aside, never deleted.
#
# Overrides (tests and non-standard layouts): PLUGIN_DEST, PROFILE_PLUGINS_DIR, HERMES_BIN, HERMES_PYTHON.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${PLUGIN_DEST:-/opt/data/plugins/resourcer}"
PROFILE_PLUGINS="${PROFILE_PLUGINS_DIR:-/opt/data/profiles/resourcer/plugins}"
HERMES="${HERMES_BIN:-hermes}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ ! -f "$SRC/dashboard/manifest.json" ]; then
  echo "INSTALL_FAILED $SRC is not the plugin directory (dashboard/manifest.json missing)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  mv "$DEST" "$DEST.old-$STAMP"
  echo "moved the previous install to $DEST.old-$STAMP"
fi
mkdir -p "$DEST"
# tar keeps the copy free of bytecode caches without any delete
(cd "$SRC" && tar cf - --exclude=__pycache__ --exclude='*.pyc' .) | (cd "$DEST" && tar xf -)
if [ ! -f "$DEST/dashboard/manifest.json" ]; then
  echo "INSTALL_FAILED copy did not produce $DEST/dashboard/manifest.json" >&2
  exit 1
fi
echo "copied the plugin to $DEST"

mkdir -p "$PROFILE_PLUGINS"
ln -sfn "$DEST" "$PROFILE_PLUGINS/resourcer"
echo "linked $PROFILE_PLUGINS/resourcer"

enable_with_python() {
  home_dir="$1"
  py="${HERMES_PYTHON:-}"
  if [ -z "$py" ]; then
    launcher="$(command -v "$HERMES" 2>/dev/null || true)"
    [ -n "$launcher" ] && py="$(head -1 "$launcher" | sed 's/^#!//')"
  fi
  [ -n "$py" ] || return 1
  HERMES_HOME="$home_dir" "$py" - <<'PY'
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
}

if "$HERMES" plugins enable resourcer && "$HERMES" -p resourcer plugins enable resourcer; then
  echo "enabled with the hermes command"
else
  echo "hermes plugins enable was refused; writing the config entries instead"
  enable_with_python "${HERMES_DEFAULT_HOME:-/opt/data}" && enable_with_python "${HERMES_PROFILE_HOME:-/opt/data/profiles/resourcer}" || {
    echo "INSTALL_FAILED could not enable the plugin; see plugin/resourcer/README.md, section Enable" >&2
    exit 1
  }
fi

"$HERMES" plugins list --enabled || true
echo "INSTALL_OK restart the dashboard now (README, section Dashboard restart), then run the checks in section Verify"
