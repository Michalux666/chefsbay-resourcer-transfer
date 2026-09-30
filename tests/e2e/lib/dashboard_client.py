"""Drives the real dashboard plugin (plugin/resourcer/dashboard/plugin_api.py) under FastAPI's TestClient against a simulated
workspace. stdin: {"home": "<RESOURCER_HOME>", "calls": [{"method": "GET", "path": "/status", "json": null, "headers": {}}]}
stdout: {"results": [{"status": 200, "json": {...}}]}. The app is built the way the Hermes dashboard mounts a plugin."""
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True  # nothing may be written into plugin/resourcer, which is copied to the instance

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
API_FILE = os.path.join(REPO, "plugin", "resourcer", "dashboard", "plugin_api.py")
PREFIX = "/api/plugins/resourcer"
MODULE_NAME = "hermes_dashboard_plugin_resourcer"


def main():
    req = json.load(sys.stdin)
    os.environ["RESOURCER_HOME"] = req["home"]
    from typing import Optional

    from fastapi import Depends, FastAPI, Query
    from fastapi.testclient import TestClient

    spec = importlib.util.spec_from_file_location(MODULE_NAME, API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = mod
    spec.loader.exec_module(mod)

    async def scope(profile: Optional[str] = Query(None)):  # what Hermes adds to every plugin route
        return None

    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX, dependencies=[Depends(scope)])
    client = TestClient(app)
    results = []
    for call in req["calls"]:
        method = call.get("method", "GET").upper()
        path = PREFIX + call["path"]
        kwargs = {}
        if call.get("json") is not None:
            kwargs["json"] = call["json"]
        if call.get("headers"):
            kwargs["headers"] = call["headers"]
        resp = client.request(method, path, **kwargs)
        try:
            body = resp.json()
        except Exception:
            body = {"_raw": resp.text[:500]}
        results.append({"status": resp.status_code, "json": body})
    print(json.dumps({"results": results}))


if __name__ == "__main__":
    main()
