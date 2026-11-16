"""Airflow 3: a TaskFlow DAG with a branch and retries, run with `airflow dags test` (no scheduler or web server).

A temporary AIRFLOW_HOME with SQLite keeps ~/airflow untouched.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # examples/stack
sys.path.insert(0, str(HERE.parent))  # automation
from common import checks  # noqa: E402

import shared  # noqa: E402

NAME = "automation/airflow"


def main() -> None:
    home = Path(tempfile.mkdtemp(prefix="stack-airflow-home-"))
    out = shared.output_dir("airflow")
    env = {**os.environ, "AIRFLOW_HOME": str(home), "AIRFLOW__CORE__DAGS_FOLDER": str(HERE / "dags"),
           "AIRFLOW__CORE__LOAD_EXAMPLES": "false", "AIRFLOW__DATABASE__SQL_ALCHEMY_CONN": f"sqlite:///{home}/airflow.db",
           "STACK_OUT": str(out), "NO_PROXY": "*", "ANTHROPIC_API_KEY": shared.config.env("ANTHROPIC_API_KEY")}
    airflow = str(Path(sys.executable).parent / "airflow")
    subprocess.run([airflow, "db", "migrate"], env=env, check=True, capture_output=True)
    proc = subprocess.run([airflow, "dags", "test", "triage"], env=env, capture_output=True, text=True, timeout=600)
    (home / "dags-test.log").write_text(proc.stdout + proc.stderr)
    results = out / "results.json"
    if not results.exists():
        print((proc.stdout + proc.stderr)[-3000:])
        checks.report(NAME, False, "dags test wrote no results.json")
        return
    data = json.loads(results.read_text())
    ok, detail = shared.check(data["results"], data["flaky_attempts"])
    print("results:", results)
    checks.report(NAME, ok, detail)


if __name__ == "__main__":
    if not shared.need_key():
        checks.skip(NAME, "set ANTHROPIC_API_KEY")
    else:
        main()
