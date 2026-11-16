"""Recreates the run_all.py findings in a throwaway copy: unknown names, tools without a venv, kept rows."""
import importlib.util, shutil, subprocess, sys
from pathlib import Path

SRC = Path(__file__).resolve().parent / "run_all.py"


def load(tmp: Path):
    stack = tmp / "examples" / "stack"
    (stack / "a" / "with-venv" / ".venv" / "bin").mkdir(parents=True)
    py = stack / "a" / "with-venv" / ".venv" / "bin" / "python"
    py.symlink_to(sys.executable)
    (stack / "a" / "with-venv" / "run.py").write_text("print('PASS a/with-venv: ok')\n")
    (stack / "a" / "no-venv").mkdir(parents=True)
    (stack / "a" / "no-venv" / "run.py").write_text("print('PASS a/no-venv: ok')\n")
    (stack / "RESULTS.md").write_text("| Area | Tool | Result | Time | Detail |\n|---|---|---|---|---|\n| a | no-venv | PASS | 1s | kept |\n")
    shutil.copy(SRC, stack / "run_all.py")
    return stack


def test_no_args_runs_only_tools_with_a_venv_and_keeps_other_rows(tmp_path):
    stack = load(tmp_path)
    subprocess.run([sys.executable, str(stack / "run_all.py")], check=True, capture_output=True)
    text = (stack / "RESULTS.md").read_text()
    assert "| a | with-venv | PASS |" in text and "| a | no-venv | PASS | 1s | kept |" in text


def test_a_named_tool_without_a_venv_keeps_its_old_row(tmp_path):
    stack = load(tmp_path)
    out = subprocess.run([sys.executable, str(stack / "run_all.py"), "a/no-venv"], capture_output=True, text=True)
    assert "NO VENV" in out.stdout and "| a | no-venv | PASS | 1s | kept |" in (stack / "RESULTS.md").read_text()


def test_an_unknown_name_fails_and_leaves_results_alone(tmp_path):
    stack = load(tmp_path)
    before = (stack / "RESULTS.md").read_text()
    out = subprocess.run([sys.executable, str(stack / "run_all.py"), "vector-db"], capture_output=True, text=True)
    assert out.returncode != 0 and "Unknown area or tool" in out.stderr
    assert (stack / "RESULTS.md").read_text() == before
