"""DevUI with both examples: the council complaint workflow and Microsoft's Foundry weather agent sample.

    python examples/agent-framework/serve_all.py        # http://127.0.0.1:8090, pick one from the selector at the top
"""
from __future__ import annotations

import os

import casework_workflow  # also reads .env
from agent_framework.devui import serve
from foundry_weather import agent as foundry_weather_agent

if __name__ == "__main__":
    # Local only: DevUI binds to 127.0.0.1, so its token auth is switched off for convenience.
    serve(entities=[casework_workflow.build_workflow(), foundry_weather_agent], port=int(os.environ.get("DEVUI_PORT", "8090")), host="127.0.0.1",
          auto_open=False, instrumentation_enabled=True, auth_enabled=False)
