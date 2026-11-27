"""The shell scripts in tools/, run for real against stand-in `docker` and `curl` commands that record what they were
asked and answer as Docker Model Runner would. Coverage cannot measure a shell script, so these are its tests."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"


@pytest.fixture
def fake_bin(tmp_path: Path) -> tuple[Path, Path]:
    """A bin folder whose `docker` logs its arguments and whose `curl` answers like the local server."""
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    bin_dir.mkdir()
    (bin_dir / "docker").write_text(f'#!/bin/sh\necho "docker $*" >> "{log}"\nexit 0\n')
    reply = json.dumps({"content": [{"type": "text", "text": "Ready."}]})
    (bin_dir / "curl").write_text(f"#!/bin/sh\necho \"curl $*\" >> \"{log}\"\necho '{reply}'\n")
    for f in bin_dir.iterdir():
        f.chmod(0o755)
    return bin_dir, log


def run_script(name: str, *args: str, bin_dir: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    clean = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": os.environ.get("HOME", "/tmp"), **(env or {})}
    return subprocess.run(["bash", str(TOOLS / name), *args], capture_output=True, text=True, env=clean, timeout=60,
                          cwd=ROOT)


def test_every_tool_script_parses():
    for script in sorted(TOOLS.glob("*.sh")):
        assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0, script.name


def test_core_pulls_the_small_model_and_checks_it_answers(fake_bin):
    bin_dir, log = fake_bin
    r = run_script("local-model.sh", "--core", bin_dir=bin_dir, env={"LLM_LAB_CORE_MODEL": "ai/tiny-core"})
    assert r.returncode == 0, r.stderr
    assert "Core model says: Ready." in r.stdout
    calls = log.read_text()
    assert "docker model pull ai/tiny-core" in calls
    assert '"model": "ai/tiny-core"' in calls  # it asked that model, not the default one


def test_the_context_comes_from_the_labs_own_setting(fake_bin):
    bin_dir, log = fake_bin
    r = run_script("local-model.sh", bin_dir=bin_dir, env={"LLM_LAB_LOCAL_MODEL": "ai/chat", "LLM_LAB_LOCAL_CONTEXT": "65536"})
    assert r.returncode == 0, r.stderr
    assert "docker model configure --context-size 65536 --keep-alive 30m ai/chat" in log.read_text()
    log.write_text("")
    r = run_script("local-model.sh", bin_dir=bin_dir, env={"LLM_LAB_LOCAL_MODEL": "ai/chat", "CONTEXT": "8192",
                                                          "LLM_LAB_LOCAL_CONTEXT": "65536"})
    assert "--context-size 8192 " in log.read_text()  # CONTEXT, given for one run, wins


def test_help_lists_the_options(fake_bin):
    bin_dir, _ = fake_bin
    r = run_script("local-model.sh", "--nope", bin_dir=bin_dir)
    assert r.returncode == 1 and "--core" in r.stdout and "--embed" in r.stdout
    for script, word in (("coverage.sh", "BASE=HEAD"), ("setup-local.sh", "--no-chat-model")):
        r = run_script(script, "--help", bin_dir=bin_dir)
        assert r.returncode == 0 and word in r.stdout, script


def test_setup_local_runs_the_core_step_and_says_when_docker_is_off(fake_bin, tmp_path):
    bin_dir, log = fake_bin
    assert "local-model.sh --core" in (TOOLS / "setup-local.sh").read_text()
    (bin_dir / "docker").write_text("#!/bin/sh\nexit 1\n")  # Docker Desktop is not running
    r = run_script("setup-local.sh", bin_dir=bin_dir)
    assert r.returncode == 1 and "Open Docker Desktop" in r.stderr


def test_coverage_help_works_before_the_environment_exists():
    """Review finding: --help was checked after need_venv, so a fresh clone got a .venv error instead of the usage."""
    script = (TOOLS / "coverage.sh").read_text()
    assert script.index("-h|--help) usage") < script.index("\nneed_venv")
