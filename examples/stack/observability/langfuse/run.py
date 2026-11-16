"""Langfuse (self-hosted): trace the six questions, score each trace, then read the traces back through the API."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # observability
import shared  # noqa: E402

NAME = "observability/langfuse"
HERE = Path(__file__).resolve().parent
LOCAL = "http://127.0.0.1:18500"
LOCAL_KEYS = ("pk-lf-lab-local", "sk-lf-lab-local")  # throwaway, created by LANGFUSE_INIT_* in docker-compose.yml


def docker_ok() -> bool:
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=20).returncode == 0
    except Exception:
        return False


def wait_ready(host: str, timeout: int = 420) -> bool:
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(host + "/api/public/health", timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def trace_questions(host: str, public: str, secret: str) -> list[str]:
    """Run the app with a trace per question: a retrieval span, a generation with usage and cost, and a score."""
    import anthropic
    from langfuse import Langfuse

    lf = Langfuse(public_key=public, secret_key=secret, host=host)
    client = anthropic.Anthropic()
    ids = []
    for g in shared.QUESTIONS:
        with lf.start_as_current_observation(name="rag-question", input={"question": g.question}) as root:
            with lf.start_as_current_observation(name="retrieval", as_type="retriever", input=g.question) as span:
                contexts = shared.retrieve(g.question)
                span.update(output=contexts)
            with lf.start_as_current_observation(
                    name="answer", as_type="generation", model=shared.MODEL,
                    input=shared.user_prompt(g.question, contexts)) as gen:
                msg = shared.generate(client, g.question, contexts)
                text = shared.text_of(msg)
                u = msg.usage
                gen.update(
                    output=text,
                    usage_details={"input": u.input_tokens, "output": u.output_tokens},
                    cost_details={"total": shared.cost(u.input_tokens, u.output_tokens)})
            root.update(output=text)
            root.score_trace(name="gold-match", value=1.0 if g.correct(text) else 0.0, data_type="NUMERIC")
            ids.append(lf.get_current_trace_id())
    lf.flush()
    return ids


def read_back(host: str, auth: tuple[str, str], ids: list[str]) -> tuple[int, int, int]:
    """Poll the public API until every trace shows up with its observations and score."""
    import requests
    found = scores = gens = 0
    end = time.time() + 120
    while time.time() < end:
        found = scores = gens = 0
        for tid in ids:
            r = requests.get(f"{host}/api/public/traces/{tid}", auth=auth, timeout=20)
            if r.status_code != 200:
                continue
            t = r.json()
            obs = t.get("observations", [])
            found += 1
            gens += any(o["type"] == "GENERATION" and (o.get("usage") or o.get("usageDetails")) for o in obs) and any(
                o["name"] == "retrieval" for o in obs)
            scores += bool(t.get("scores"))
        if found == len(ids) and gens == len(ids) and scores == len(ids):
            break
        time.sleep(5)
    return found, gens, scores


def main() -> None:
    if not config.HAS_CLAUDE:
        return checks.skip(NAME, "set ANTHROPIC_API_KEY")
    cloud = all(config.env(k) for k in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"))
    started = False
    if cloud:
        host, keys = config.env("LANGFUSE_HOST").rstrip("/"), (config.env("LANGFUSE_PUBLIC_KEY"), config.env("LANGFUSE_SECRET_KEY"))
    elif docker_ok():
        host, keys = LOCAL, LOCAL_KEYS
        subprocess.run(["docker", "compose", "up", "-d"], cwd=HERE, check=True)
        started = True
    else:
        return checks.skip(NAME, "start Docker (about 3 GB), or set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_HOST for Langfuse Cloud")
    try:
        if not wait_ready(host):
            return checks.report(NAME, False, "Langfuse did not become healthy in time")
        ids = trace_questions(host, keys[0], keys[1])
        found, gens, scores = read_back(host, keys, ids)
        n = len(ids)
        checks.report(NAME, found == gens == scores == n,
                      f"{found}/{n} traces read back, {gens}/{n} with retrieval span and generation tokens, {scores}/{n} with a score")
    finally:
        if started:
            subprocess.run(["docker", "compose", "down", "-v"], cwd=HERE)


if __name__ == "__main__":
    main()
