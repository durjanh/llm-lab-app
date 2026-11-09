"""Microsoft Agent Framework workflows, run from the examples in examples/agent-framework/workflows.

The page and the command line run the same files. Each run gets its own event loop on the run's worker thread, and
signs in to Azure OpenAI with your Azure login. The YAML workflow needs Python 3.12 for its Power Fx engine, so it runs
as a subprocess from its own environment and reports its events as lines of JSON.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from collections.abc import Callable
from typing import Protocol

from ..core.errors import ApiError
from ..shared import ROOT, agent_workflows

EXAMPLES = ROOT / "examples" / "agent-framework" / "workflows"
OWN_ENVIRONMENT = {"declarative": "13_declarative.py"}  # patterns that can't run on the backend's Python
SUBPROCESS_TIMEOUT_S = 180


class WorkflowRunner(Protocol):
    model: str

    def run(self, pattern: str, task: str | None, *, emit: Callable[[dict], None], ask: Callable[[str, str], bool],
            stop: Callable[[], str | None], on_usage: Callable[[int, int], None]) -> None: ...


class AgentWorkflows:
    def __init__(self, endpoint: str, model: str):
        self.endpoint, self.model = endpoint, model

    def run(self, pattern: str, task: str | None, *, emit: Callable[[dict], None], ask: Callable[[str, str], bool],
            stop: Callable[[], str | None], on_usage: Callable[[int, int], None]) -> None:
        """Runs one workflow type to the end. Its events go to emit; a question for a person goes to ask."""
        if pattern in OWN_ENVIRONMENT:
            self._run_separately(OWN_ENVIRONMENT[pattern], task, emit, stop, on_usage)
            return
        try:
            examples = agent_workflows()
        except ImportError as exc:
            raise ApiError(503, "not_installed",
                           "Install Agent Framework: pip install -r examples/agent-framework/requirements.txt") from exc
        trace = examples.Trace(emit, ask, stop, on_usage)
        try:
            asyncio.run(examples.run_pattern(pattern, task, trace, self.endpoint, self.model))
        except Exception as exc:  # the framework wraps the SDKs' errors in its own; read them by name and text
            reason = stop()
            raise ApiError(409, "stopped", reason) if reason else _api_error(exc) from exc


    def _run_separately(self, script: str, task: str | None, emit: Callable[[dict], None], stop: Callable[[], str | None],
                        on_usage: Callable[[int, int], None]) -> None:
        python = EXAMPLES / ".venv" / "bin" / "python"
        if not python.exists():
            raise ApiError(503, "not_installed", "This workflow needs its own environment. In examples/agent-framework/workflows run: "
                                                 "python3.12 -m venv .venv && .venv/bin/pip install -r requirements-declarative.txt")
        command = [str(python), script, "--jsonl", "--endpoint", self.endpoint, "--model", self.model, *(["--task", task] if task else [])]
        read_lines(command, emit, stop, on_usage)


def read_lines(command: list[str], emit: Callable[[dict], None], stop: Callable[[], str | None],
               on_usage: Callable[[int, int], None]) -> None:
    """Runs a workflow script and passes on its @@-prefixed JSON lines. Anything else it prints is kept for the error."""
    process = subprocess.Popen(command, cwd=EXAMPLES, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    timer = threading.Timer(SUBPROCESS_TIMEOUT_S, process.kill)
    timer.start()
    other: list[str] = []
    try:
        for line in process.stdout:
            if line.startswith("@@"):
                event = json.loads(line[2:])
                if event["type"] == "tokens":
                    on_usage(event["input"], event["output"])
                else:
                    emit(event)
            else:
                other = [*other[-20:], line.rstrip()]
            if reason := stop():
                process.kill()
                raise ApiError(409, "stopped", reason)
    finally:
        timer.cancel()
    if process.wait() != 0:
        raise _api_error(RuntimeError(" ".join(other[-3:])))


def _api_error(exc: Exception) -> ApiError:
    words = f"{type(exc).__name__} {exc}".lower()
    if any(w in words for w in ("credential", "authentication", "401", "403", "permission")):
        return ApiError(502, "azure_auth", "Azure refused the sign-in. Run az login, and check your account has the "
                                           "Cognitive Services OpenAI User role on the Foundry resource.")
    if "429" in words or "rate limit" in words:
        return ApiError(429, "rate_limited", "The Azure OpenAI model is busy (rate limited). Wait a moment and try again.")
    return ApiError(502, "agent_framework", f"The workflow failed: {str(exc)[:300]}")
