"""Loads the real dashboard plugin and prints what its status readers make of a workspace as one JSON line.

usage: RESOURCER_HOME=<workspace> python plugin_probe.py <path to plugin_api.py>
"""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("plugin_api", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

events = module.last_watchdog_events()
activity = module.last_activity(None, events)
print(json.dumps({
    "caterer": module.caterer_state(events),
    "backup": module.backup_state(module.load_settings()),
    "activity": activity.isoformat() if activity else None,
    "eventCount": len(events),
}, default=str))
