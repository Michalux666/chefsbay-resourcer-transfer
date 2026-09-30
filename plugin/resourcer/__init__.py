"""resourcer: agent-side shell for a dashboard-only plugin.

Hermes lists and enables a user plugin only when it has a plugin.yaml, and the agent loader then imports
this file and calls register(ctx). The real work lives in ./dashboard/ (manifest.json, plugin_api.py, dist/).
"""


def register(ctx):
    """No tools, hooks or commands to register."""
    return None
