"""An autonomous agent that keeps working until the job is done.

Companion to the Harness engineering lab. The model decides each next step;
the harness decides when the job is really done. The harness:

- creates a small project with two bugs and failing tests in a temporary folder,
- gives Claude tools to list, read and write files there, run the tests, and keep a todo list,
- accepts "finish" only when the tests really pass (the verification gate),
- stops on success, after --max-turns, or when the estimated spend reaches --budget,
- trims tool output when it is created, so the conversation history stays append-only.

    python 09_autonomous_agent.py
    python 09_autonomous_agent.py --max-turns 10 --budget 0.25 --keep
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of, tool

BUGGY_BILLING = '''def apply_discount(price, percent):
    """Price after a percentage discount, in pounds and pence."""
    return round(price * (1 - percent / 100))


def split_bill(total, people):
    """Split a bill into shares that add up exactly to the total."""
    share = round(total / people, 2)
    return [share] * people
'''

TESTS = '''import unittest

from billing import apply_discount, split_bill


class BillingTests(unittest.TestCase):
    def test_discount_keeps_pence(self):
        self.assertEqual(apply_discount(19.99, 10), 17.99)

    def test_discount_zero(self):
        self.assertEqual(apply_discount(5.00, 0), 5.00)

    def test_split_adds_up(self):
        shares = split_bill(10.00, 3)
        self.assertEqual(len(shares), 3)
        self.assertAlmostEqual(sum(shares), 10.00, places=2)

    def test_split_even(self):
        self.assertEqual(split_bill(9.00, 3), [3.0, 3.0, 3.0])


if __name__ == "__main__":
    unittest.main()
'''

SYSTEM = """You are an autonomous software engineer working alone in a small Python project.
Your job: make every test pass without changing the tests.
1. First, write a short plan with update_todos. Keep it updated as you work.
2. Use the tools to inspect, edit and test the code.
3. When you believe the job is done, call finish. The harness will run the tests itself
   and tell you if anything still fails.
Nobody is available to answer questions, so do not ask any. Keep going until the tests pass."""

MAX_OUTPUT = 2000  # characters of tool output sent back to the model


TOOLS = [
    tool("list_files", "List the files in the project.", {}),
    tool("read_file", "Read a file in the project.", {"path": {"type": "string", "description": "File name, for example billing.py"}}),
    tool("write_file", "Replace the whole content of a file in the project.",
         {"path": {"type": "string"}, "content": {"type": "string", "description": "The complete new file content"}}),
    tool("run_tests", "Run the project's unit tests and return the report.", {}),
    tool("update_todos", "Replace the todo list with the current plan and progress.",
         {"todos": {"type": "array", "items": {"type": "object", "properties": {"task": {"type": "string"}, "done": {"type": "boolean"}},
                                               "required": ["task", "done"], "additionalProperties": False}}}),
    tool("finish", "Call when the job is done. The harness verifies it by running the tests.",
         {"summary": {"type": "string", "description": "What you changed and why"}}),
]


class Workspace:
    def __init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="agent-workspace-"))
        (self.root / "billing.py").write_text(BUGGY_BILLING)
        (self.root / "test_billing.py").write_text(TESTS)
        self.todos: list[dict] = []

    def path(self, name: str) -> Path:
        p = (self.root / name).resolve()
        if self.root.resolve() not in p.parents or p.suffix not in {".py", ".md", ".txt"}:
            raise ValueError(f"{name} is outside the project or not an allowed file type.")
        return p

    def run_tests(self) -> tuple[bool, str]:
        proc = subprocess.run([sys.executable, "-m", "unittest", "-q"], cwd=self.root,
                              capture_output=True, text=True, timeout=60)
        report = (proc.stdout + proc.stderr).strip()
        return proc.returncode == 0, report[-MAX_OUTPUT:]

    def call(self, name: str, args: dict) -> str:
        if name == "list_files":
            return "\n".join(sorted(p.name for p in self.root.iterdir() if p.is_file()))
        if name == "read_file":
            return self.path(args["path"]).read_text()[:MAX_OUTPUT * 4]
        if name == "write_file":
            if Path(args["path"]).name.startswith("test_"):
                raise ValueError("The tests are the definition of done and must not be changed.")
            self.path(args["path"]).write_text(args["content"])
            return f"Wrote {len(args['content'])} characters to {args['path']}."
        if name == "run_tests":
            return self.run_tests()[1]
        if name == "update_todos":
            self.todos = args["todos"]
            return "\n".join(f"[{'x' if t['done'] else ' '}] {t['task']}" for t in self.todos)
        raise ValueError(f"Unknown tool {name}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max-turns", type=int, default=15)
    parser.add_argument("--budget", type=float, default=0.50, help="stop when the estimated spend reaches this many dollars")
    parser.add_argument("--keep", action="store_true", help="keep the temporary project folder afterwards")
    model_argument(parser)
    args = parser.parse_args()
    client, ws = make_client(), Workspace()
    print(f"Project created in {ws.root}")
    print(f"Starting tests: {'pass' if ws.run_tests()[0] else 'FAIL'}\n")

    messages: list[dict] = [{"role": "user", "content": "Make all the tests in this project pass."}]
    spent, outcome = 0.0, None
    try:
        for turn in range(1, args.max_turns + 1):
            if spent >= args.budget:
                outcome = f"Stopped: estimated spend ${spent:.2f} reached the ${args.budget:.2f} budget. A person should take a look."
                break
            response = create(client, model=args.model, max_tokens=16000, system=SYSTEM, tools=TOOLS, messages=messages)
            spent += cost_usd(response.usage, args.model) or 0
            ensure_answered(response)
            messages.append({"role": "assistant", "content": response.content})  # append-only history
            print(f"Turn {turn}  (spent about ${spent:.3f})")
            for block in response.content:
                if block.type == "text" and block.text.strip():
                    print(f"  model: {block.text.strip()[:200]}")

            if response.stop_reason != "tool_use":
                messages.append({"role": "user", "content": "Keep going until the tests pass, then call finish."})
                continue

            results = []
            for block in (b for b in response.content if b.type == "tool_use"):
                print(f"  tool: {block.name}({json.dumps(block.input)[:120]})")
                if block.name == "finish":
                    passed, report = ws.run_tests()  # the verification gate: check the claim
                    if passed:
                        outcome = f"Done in {turn} turns, verified by the harness: all tests pass.\nModel's summary: {block.input['summary']}"
                        break
                    print("  harness: finish rejected, tests still fail")
                    results.append({"type": "tool_result", "tool_use_id": block.id, "is_error": True,
                                    "content": "Not done. The harness ran the tests and they still fail:\n" + report})
                    continue
                try:
                    output, failed = ws.call(block.name, block.input), False
                except Exception as exc:  # tool errors go back to the model, not up the stack
                    output, failed = f"Error: {exc}", True
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": output[:MAX_OUTPUT * 4], "is_error": failed})
            if outcome:
                break
            messages.append({"role": "user", "content": results})  # all results in one message
        else:
            outcome = f"Stopped after {args.max_turns} turns without finishing. A person should take a look."
    finally:
        print("\nTodo list:")
        for t in ws.todos:
            print(f"  [{'x' if t['done'] else ' '}] {t['task']}")
        print(f"\n{outcome}\nEstimated spend: ${spent:.3f}")
        if args.keep:
            print(f"Project kept at {ws.root}")
        else:
            shutil.rmtree(ws.root, ignore_errors=True)


if __name__ == "__main__":
    run(main)
