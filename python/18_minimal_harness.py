"""A minimum viable harness: the seven subsystems of a coding agent, each in its smallest form.

Companion to the Harness engineering lab. "Harness Engineering" (Barbaste, Darrigol, Vu and Wiltberger,
July 2026) read the source of eleven coding agents, Claude Code and Codex among them, and found that each
one takes a position on the same seven subsystems. This file is the smallest form of each, laid out the
way the paper's figure lays it out:

  loop()      call, act, observe, repeat, until Claude answers without asking for a tool
  llm.call()  one template, one provider: every request has the same shape, and the spend is counted
  tools       bash only (Anthropic's bash tool), run in the folder you name
  history     the full message list, kept whole: nothing is trimmed or summarised
  guard()     step and cost limits
  -           no sub-agents, on purpose
  plugins     any object with a matching method plugs in: before(command) can refuse a command,
              after(command, output) can rewrite its output. The permission check is a plugin too

11_harness_loop.py grows each subsystem: ten tools, permission rules, hooks, parallel calls, sub-agents
and compaction. Like the agents in the paper, neither imports an agent framework.

Commands run for real, so ReadOnly lets through only programs that read, joined by pipes at most.

    python 18_minimal_harness.py
    python 18_minimal_harness.py "Which function in common.py is used by the most scripts?" --folder python
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of

BASH = {"type": "bash_20250124", "name": "bash"}  # Anthropic-defined: the schema is built into the model
SYSTEM = "You are a coding agent in the folder {folder}. Look with the bash tool before you answer. Be brief."
READ_ONLY = {"ls", "cat", "head", "tail", "wc", "grep", "find", "sort", "uniq", "cut", "tr", "file", "pwd", "echo"}


class StopRun(Exception):
    """A limit was reached."""


# --- plugins: any object with before() or after() ------------------------------

class Log:
    def before(self, command: str) -> None:
        print(f"$ {command}")

    def after(self, command: str, output: str) -> str:
        print("  " + "\n  ".join(output.splitlines()[:3])[:300])
        return output


class ReadOnly:
    """Refuses anything that could change a file: read-only programs only, joined by pipes at most."""

    def before(self, command: str) -> str | None:
        if any(op in command for op in (";", "&", ">", "<", "`", "$(")):
            return "only single commands and pipes are allowed"
        for part in command.split("|"):
            words = part.split()
            if not words or words[0] not in READ_ONLY or {"-delete", "-exec", "-execdir"} & set(words):
                return f"'{part.strip()}' is not on the read-only list: {', '.join(sorted(READ_ONLY))}"
        return None


class Trim:
    def after(self, command: str, output: str, limit: int = 4000) -> str:
        return output if len(output) <= limit else output[:limit] + f"\n[{len(output) - limit} characters trimmed]"


PLUGINS = [Log(), ReadOnly(), Trim()]


# --- llm.call(): one template, one provider --------------------------------------

class LLM:
    def __init__(self, model: str, folder: Path) -> None:
        self.client, self.model, self.system, self.spent = make_client(), model, SYSTEM.format(folder=folder), 0.0

    def call(self, history: list[dict]):
        resp = create(self.client, model=self.model, max_tokens=8000, system=self.system, tools=[BASH],
                      messages=history, output_config={"effort": "low"})
        self.spent += cost_usd(resp.usage, self.model) or 0.0
        ensure_answered(resp)
        return resp


# --- tools: bash only -------------------------------------------------------------

def act(block, folder: Path) -> dict:
    """Runs one bash call through the plugins and returns its tool_result."""
    command = block.input.get("command", "")
    if block.input.get("restart") or not command:
        return {"type": "tool_result", "tool_use_id": block.id, "content": "The shell was restarted."}
    refusal = next((r for p in PLUGINS if hasattr(p, "before") and (r := p.before(command))), None)
    if refusal:
        print(f"  refused: {refusal}")
        return {"type": "tool_result", "tool_use_id": block.id, "content": f"Refused: {refusal}", "is_error": True}
    try:
        done = subprocess.run(command, shell=True, cwd=folder, capture_output=True, text=True, timeout=30)
        output, failed = (done.stdout + done.stderr).strip() or f"(exit code {done.returncode})", done.returncode != 0
    except subprocess.TimeoutExpired:
        output, failed = "Timed out after 30 seconds.", True
    for p in PLUGINS:
        output = p.after(command, output) if hasattr(p, "after") else output
    return {"type": "tool_result", "tool_use_id": block.id, "content": output, "is_error": failed}


# --- guard(): step and cost limits -------------------------------------------------

def guard(step: int, llm: LLM, max_steps: int, budget: float) -> None:
    if step > max_steps:
        raise StopRun(f"reached the limit of {max_steps} steps")
    if llm.spent >= budget:
        raise StopRun(f"the estimated spend ${llm.spent:.4f} reached the ${budget:.2f} budget")


# --- loop(): call, act, observe, repeat ---------------------------------------------

def loop(task: str, folder: Path, llm: LLM, max_steps: int, budget: float) -> str:
    history: list[dict] = [{"role": "user", "content": task}]  # kept whole
    for step in range(1, max_steps + 2):
        guard(step, llm, max_steps, budget)
        resp = llm.call(history)
        history.append({"role": "assistant", "content": resp.content})
        calls = [b for b in resp.content if b.type == "tool_use"]
        if not calls:
            return text_of(resp).strip()
        history.append({"role": "user", "content": [act(b, folder) for b in calls]})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("task", nargs="?", default="Which lesson script here is the longest, and what does it do?")
    parser.add_argument("--folder", type=Path, default=Path(__file__).parent, help="where commands run")
    parser.add_argument("--max-steps", type=int, default=12)
    parser.add_argument("--budget", type=float, default=0.05, help="stop at this estimated spend, in dollars")
    model_argument(parser)
    args = parser.parse_args()
    folder = args.folder.resolve()
    llm = LLM(args.model, folder)
    print(f"Task: {args.task}\nFolder: {folder}\n")
    try:
        print(f"\nAnswer: {loop(args.task, folder, llm, args.max_steps, args.budget)}")
    except StopRun as exc:
        print(f"\nStopped by the guard: {exc}")
    print(f"Estimated cost: ${llm.spent:.4f}")


if __name__ == "__main__":
    run(main)
