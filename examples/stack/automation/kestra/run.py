"""Kestra in Docker: upload flow.yaml through the API, execute it with the five emails, poll, and read the outputs.

The key goes to the container as a base64 environment variable (Kestra's SECRET_ convention), never into a file.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks  # noqa: E402

import shared  # noqa: E402

NAME = "automation/kestra"
BASE = "http://127.0.0.1:18811/api/v1"
AUTH = "Basic " + base64.b64encode(b"lab@example.com:LabLocal1234").decode()  # the throwaway login in docker-compose.yml
KEY = shared.config.env("ANTHROPIC_API_KEY")
ENV = {**os.environ, "KESTRA_SECRET_ANTHROPIC_API_KEY": base64.b64encode(KEY.encode()).decode()}


def compose(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "compose", *args], cwd=HERE, env=ENV, capture_output=True, text=True,
                          check=check, timeout=900)


def call(method: str, path: str, data: bytes | None = None, ctype: str | None = None) -> dict:
    headers = {"Authorization": AUTH, **({"Content-Type": ctype} if ctype else {})}
    req = urllib.request.Request(BASE + path, data, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path}: {e.code} {e.read()[:500]!r}") from None
    return json.loads(body) if body else {}


def wait_for_server() -> None:
    for _ in range(90):
        try:
            call("GET", "/flows/search?size=1")
            return
        except (RuntimeError, OSError):
            time.sleep(3)
    raise RuntimeError("Kestra did not start")


def execute() -> dict:
    flow = (HERE / "flow.yaml").read_text().encode()
    call("POST", "/flows", flow, "application/x-yaml")
    emails = json.dumps({e["id"]: e for e in shared.EMAILS})
    boundary = uuid.uuid4().hex
    form = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"emails\"\r\n\r\n{emails}\r\n--{boundary}--\r\n").encode()
    ex = call("POST", "/executions/stack/triage", form, f"multipart/form-data; boundary={boundary}")
    for _ in range(120):
        ex = call("GET", f"/executions/{ex['id']}")
        if ex["state"]["current"] in ("SUCCESS", "FAILED", "WARNING", "KILLED", "CANCELLED"):
            return ex
        time.sleep(3)
    raise RuntimeError("execution did not finish")


def collect() -> tuple[list[dict], int]:
    """The CRM keeps what the flow's last task sent it, and the attempt that got through."""
    with urllib.request.urlopen("http://127.0.0.1:18812/", timeout=10) as r:
        got = json.load(r)
    records = [item["outputs"]["record"] for item in got.get("body") or []]  # one entry per loop iteration
    return sorted(records, key=lambda r: r["id"]), got.get("attempt", 0)


def main() -> None:
    compose("down", "-v", check=False)
    try:
        compose("up", "-d")
        wait_for_server()
        ex = execute()
        results, attempt = collect()
        if ex["state"]["current"] != "SUCCESS":
            print("execution state:", ex["state"]["current"])
            for sub in call("GET", "/executions/search?size=20")["results"]:  # a Loop runs each item as a sub-execution
                for log in call("GET", f"/logs/{sub['id']}?minLevel=INFO"):
                    print("  ", log["level"], log.get("taskId", ""), str(log["message"])[:300])
        path = shared.write_results(shared.output_dir("kestra"), results, attempt)
        ok, detail = shared.check(results, attempt)
        print("results:", path)
        checks.report(NAME, ok, detail)
    finally:
        compose("down", "-v", check=False)


if __name__ == "__main__":
    if not shared.need_key():
        checks.skip(NAME, "set ANTHROPIC_API_KEY")
    elif subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        checks.skip(NAME, "start Docker")
    else:
        main()
