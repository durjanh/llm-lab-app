"""Run the LLM Lab backend.

    python -m backend --budget 1            # http://localhost:8000; stops after about $1
    python -m backend --port 8080 --reload  # another port, restarting on code changes

It listens on 127.0.0.1 only, refuses API calls from other websites, caps max_tokens,
and stops making calls once the estimated spend for this run reaches --budget dollars.
If an earlier backend is still running on the port, it is stopped first.
"""
from __future__ import annotations

import argparse
import errno
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

import uvicorn

SHUTDOWN_GRACE_S = 2  # Ctrl+C waits this long for open requests, such as a deck being built, then stops them
STOP_WAIT_S = 5  # how long an earlier backend gets to stop before it is forced


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as uvicorn does, so only a live server counts
        try:
            s.bind(("127.0.0.1", port))
            return False
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            return True


def holders(port: int) -> dict[int, tuple[str, str]]:
    """The processes listening on the port: pid -> (state, command)."""
    if not shutil.which("lsof"):
        return {}
    pids = subprocess.run(["lsof", "-tiTCP:%d" % port, "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    if not pids:
        return {}
    out = subprocess.run(["ps", "-o", "pid=,stat=,command=", "-p", ",".join(pids)], capture_output=True, text=True).stdout
    found = {}
    for line in out.splitlines():
        pid, state, command = line.strip().split(None, 2)
        found[int(pid)] = (state, command)
    return found


def free_port(port: int) -> str | None:
    """Stops an earlier LLM Lab backend on the port. None when the port is free, otherwise why it is not.

    An earlier backend may have been paused with Ctrl+Z instead of stopped with Ctrl+C. A paused
    process keeps the port and cannot act on a stop request, so it is woken first.
    """
    if not port_in_use(port):
        return None
    found = holders(port)
    ours = {pid: info for pid, info in found.items() if " -m backend" in info[1]}
    if not found or len(ours) < len(found):
        listed = "\n".join(f" {pid} {command}" for pid, (_, command) in found.items())
        return (f"Port {port} is in use by another program:\n{listed}\n"
                f"Stop it, or start the backend on another port with --port {port + 1}.")
    paused = [pid for pid, (state, _) in ours.items() if state.startswith("T")]
    print(f"Stopping the earlier backend on port {port} (process {', '.join(map(str, ours))})"
          + (", which was paused with Ctrl+Z. Use Ctrl+C to stop it next time." if paused else "."), flush=True)
    for pid in ours:
        for sig in (signal.SIGCONT, signal.SIGTERM):  # wake it if paused, then ask it to stop
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
    for forced in (False, True):
        deadline = time.monotonic() + (STOP_WAIT_S if not forced else 2)
        while time.monotonic() < deadline:
            if not port_in_use(port):
                return None
            time.sleep(0.2)
        if not forced:
            for pid in ours:  # it did not stop in time: force it
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    return f"Port {port} is still in use. Start the backend on another port with --port {port + 1}."


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m backend", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--budget", type=float, default=2.0, help="stop making API calls after this many dollars")
    parser.add_argument("--reload", action="store_true", help="restart when backend code changes")
    args = parser.parse_args()

    # The app reads its settings from the environment, so --reload's worker processes see them too.
    os.environ["LLM_LAB_PORT"] = str(args.port)
    os.environ["LLM_LAB_BUDGET"] = str(args.budget)

    if problem := free_port(args.port):
        sys.exit(problem)

    from .app.main import app  # noqa: F401  (fails fast on import errors before uvicorn starts)
    ok = app.state.container.status.has_credentials()
    print(f"LLM Lab backend at http://localhost:{args.port}  ·  API docs at http://localhost:{args.port}/docs", flush=True)
    print(f"Claude API credentials: {'found' if ok else 'not found. Live features are off. Set ANTHROPIC_API_KEY and restart.'}", flush=True)
    print(f"Spending cap for this run: ${args.budget:.2f}. Press Ctrl+C to stop.", flush=True)
    uvicorn.run("backend.app.main:app" if args.reload else app, host="127.0.0.1", port=args.port,
                reload=args.reload, reload_dirs=["backend", "python"] if args.reload else None, log_level="warning",
                timeout_graceful_shutdown=SHUTDOWN_GRACE_S)


if __name__ == "__main__":
    main()
