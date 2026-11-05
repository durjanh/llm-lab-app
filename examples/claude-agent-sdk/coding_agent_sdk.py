"""The same coding agent as python/19_coding_agent.py, on the Claude Agent SDK: Claude Code's own harness.

19_coding_agent.py builds every part by hand. Here the SDK runs Claude Code (its CLI ships inside the package),
so the loop, the file tools, the shell, checkpoints, context management and sub-agents are Claude Code's own.
What is left to you is configuration and a few callbacks:

  tools / agents       which built-in tools exist, and an `explore` sub-agent with only the reading tools
  permission_mode      default, acceptEdits, plan or bypassPermissions, as in Claude Code
  allowed_tools        allow rules (Bash(python -m unittest *)), disallowed_tools deny rules (Bash(git push *))
  can_use_tool         called for whatever the rules leave to a person: here the terminal, or the lab page
  hooks                PreToolUse refuses .env and .git; PostToolUse checks Python syntax after an edit; Stop sends the
                       agent back to work while the tests fail, if it changed anything
  sandbox              --mode auto: bypassPermissions with Claude Code's own sandbox on, so commands run without asking
                       but can write only in the project, and reach only the package index
  mcp_servers          your own tools, in process: here `screenshot`, which renders a page in headless Chrome and
                       returns the picture as an image block. Claude Code's Read already returns images itself.
  setting_sources      ["project"] loads the project's CLAUDE.md and nothing from your own ~/.claude
  max_turns, max_budget_usd   the run's limits; the result reports turns and cost

    .venv/bin/python coding_agent_sdk.py                        # fix the failing tests, asking before edits
    .venv/bin/python coding_agent_sdk.py --task feature --mode acceptEdits
    .venv/bin/python coding_agent_sdk.py --json --folder /tmp/x # one JSON event per line, for the lab backend

With --json, a permission prompt is printed as {"type": "approval", ...} and the answer is read from stdin as
{"id": ..., "allow": true}, so the lab page approves SDK runs the same way it approves the hand-built harness.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path
from typing import Any

from claude_agent_sdk import (AgentDefinition, AssistantMessage, CanUseToolShadowedWarning, ClaudeAgentOptions,
                              ClaudeSDKClient, HookMatcher,
                              PermissionResultAllow, PermissionResultDeny, ResultMessage, SystemMessage, TextBlock,
                              ToolPermissionContext, ToolResultBlock, ToolUseBlock, UserMessage,
                              create_sdk_mcp_server, tool)

# Allow rules that name a whole tool (Read, Grep...) approve it before can_use_tool is asked; the SDK warns about
# that on every run. It is what we want here: reading needs no person.
warnings.filterwarnings("ignore", category=CanUseToolShadowedWarning)

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "python" / "coding_project"
TASKS = {  # the same tasks as python/19_coding_agent.py
    "fix": "The tests are failing. Find out why and fix the code.",
    "feature": "Add a command-line report: `python -m ledger data/sample.csv` should print money out by category and "
               "the net amount by month. Add a test for it, and keep every test passing.",
    "plan": "Plan how to add monthly budgets per category: a limit for each category, and a warning when a month's "
            "spending passes it. Do not change any files.",
    "cleanup": "Clear out the project with `rm -rf data tests`, then force-push it with `git push --force origin main`.",
    "excel": "Export money out by category and the net amount by month from data/sample.csv to report.xlsx, a real "
             "Excel workbook with one sheet for each and a total row on the first. Then open it again in code to check "
             "the numbers.",
    "page": "Make report.html: a horizontal bar chart of money out by category in data/sample.csv, drawn with inline "
            "SVG and no libraries, each bar labelled with its category and amount. Then look at it with a screenshot "
            "and fix anything cut off, overlapping or hard to read.",
}
MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "auto"]  # auto: sandboxed bypass, as in the hand-built one
SCREENSHOT = "mcp__lab__screenshot"  # an SDK tool is named mcp__<server>__<tool>
CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
ALLOW = ["Read", "Glob", "Grep", "TodoWrite", "Task", SCREENSHOT, "Bash(python -m unittest *)",
         "Bash(python3 -m unittest *)",
         "Bash(ls *)", "Bash(cat *)", "Bash(git status *)", "Bash(git diff *)"]
AUTO_DENY = ["Bash(sudo *)", "Bash(ssh *)", "Bash(scp *)", "Bash(git push *)", "WebFetch", "WebSearch"]
SANDBOX = {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False,
           "network": {"allowedDomains": ["pypi.org", "files.pythonhosted.org"]}}  # pip works; nothing else is reachable
DENY = ["Bash(rm -rf *)", "Bash(rm -r *)", "Bash(sudo *)", "Bash(curl *)", "Bash(wget *)", "Bash(ssh *)",
        "Bash(git push *)", "Bash(git reset --hard *)", "Bash(pip install *)", "WebFetch", "WebSearch"]


def emit(event: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(event, default=str), flush=True)
    elif event["type"] == "text":
        print(f"\n{'    ' * event['depth']}{event['who']}: {event['text']}\n", flush=True)
    elif event["type"] == "tool_use":
        print(f"{'    ' * event['depth']}→ {event['name']} {json.dumps(event['input'])[:160]}", flush=True)
    elif event["type"] == "stop_check":
        print(f"■ stop check: {event['command']} {'passes' if event['passed'] else 'fails, so the agent carries on'}", flush=True)
    elif event["type"] == "result":
        first = event["content"].splitlines()[0] if event["content"] else ""
        print(f"{'    ' * event['depth']}  {'✗' if event['is_error'] else '←'} {first[:140]}", flush=True)


def proposed_diff(folder: Path, name: str, args: dict) -> str:
    """What an Edit or Write would change, for the person deciding whether to allow it."""
    path = Path(args.get("file_path", ""))
    path = path if path.is_absolute() else folder / path
    before = path.read_text(encoding="utf-8") if path.exists() else ""
    if name == "Write":
        after = args.get("content", "")
    elif name == "Edit":
        old, new = args.get("old_string", ""), args.get("new_string", "")
        after = before.replace(old, new) if args.get("replace_all") else before.replace(old, new, 1)
    else:
        return ""
    rel = path.resolve().relative_to(folder.resolve()).as_posix() if path.resolve().is_relative_to(folder.resolve()) else str(path)
    return "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), f"a/{rel}", f"b/{rel}"))


def make_permission_callback(folder: Path, as_json: bool, yes: bool):
    async def can_use_tool(name: str, args: dict[str, Any], ctx: ToolPermissionContext):
        """Called for every call the rules and the mode leave to a person."""
        if yes:
            return PermissionResultAllow()
        reason = ctx.title or ctx.decision_reason or "needs approval"
        if as_json:
            if name in ("Edit", "Write"):
                emit({"type": "diff", "id": ctx.tool_use_id, "path": args.get("file_path", ""),
                      "diff": proposed_diff(folder, name, args)}, True)
            emit({"type": "approval", "id": ctx.tool_use_id, "name": name, "input": args, "reason": reason,
                  "who": "agent", "depth": 1 if ctx.agent_id else 0}, True)
            line = await asyncio.to_thread(sys.stdin.readline)
            allow = bool(line.strip()) and json.loads(line).get("allow") is True
        elif sys.stdin.isatty():
            print(proposed_diff(folder, name, args), end="")
            what = args.get("command") or args.get("file_path") or ""
            allow = input(f"    Allow {name} {what}? ({reason}) [y/N] ").strip().lower() == "y"
        else:
            allow = False  # nobody to ask, so the call is refused
        return PermissionResultAllow() if allow else PermissionResultDeny(message="A person said no.")
    return can_use_tool


async def protect_files(data: dict, tool_use_id: str | None, context: Any) -> dict:
    """PreToolUse: secrets and git history are off limits, whatever the mode. Commands may not touch .env."""
    args = data.get("tool_input", {})
    if re.search(r"(^|/)(\.env|\.git)(/|$)", args.get("file_path", "")) or \
            re.search(r"(^|[\s/])\.env\b", args.get("command", "")):
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": "Blocked by a hook: .env and .git are protected."}}
    return {}


async def check_python(data: dict, tool_use_id: str | None, context: Any) -> dict:
    """PostToolUse: after Python is edited, compile it, so a syntax error comes back at once."""
    path = Path(data.get("tool_input", {}).get("file_path", ""))
    if path.suffix == ".py" and path.exists():
        try:
            compile(path.read_text(encoding="utf-8"), str(path), "exec")
        except SyntaxError as exc:
            return {"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                           "additionalContext": f"Syntax check failed (hook): {exc.msg} at line {exc.lineno}."}}
    return {}


def make_stop_hook(folder: Path, as_json: bool):
    """Stop: if the agent changed anything (git status says so), it is not done until the tests pass. Returning
    decision "block" with a reason makes Claude Code carry on with that reason as its next instruction."""
    checks = {"count": 0}

    async def tests_pass(data: dict, tool_use_id: str | None, context: Any) -> dict:
        status = subprocess.run(["git", "status", "--porcelain"], cwd=folder, capture_output=True, text=True).stdout
        if checks["count"] >= 3 or not status.strip():
            return {}
        venv = folder / ".venv" / "bin"
        env = {**os.environ, "PATH": f"{venv}{os.pathsep}{os.environ.get('PATH', '')}", "PYTHONDONTWRITEBYTECODE": "1"}
        proc = await asyncio.to_thread(subprocess.run, "python3 -m unittest -q", shell=True, cwd=folder, env=env,
                                       capture_output=True, text=True, timeout=120)
        out = (proc.stdout + proc.stderr)[-1500:]
        emit({"type": "stop_check", "passed": proc.returncode == 0, "command": "python -m unittest -q", "output": out},
             as_json)
        if proc.returncode == 0:
            return {}
        checks["count"] += 1
        return {"decision": "block", "reason": f"You changed files, and the tests fail:\n{out}\nYou are not finished. "
                                               "Carry on until they pass. If they cannot pass, say exactly why."}
    return tests_pass


def chrome() -> str | None:
    return os.environ.get("LLM_LAB_CHROME") or next((p for p in CHROME_PATHS if Path(p).is_file()), None) or next(
        (found for name in ("google-chrome", "chromium", "chrome", "msedge") if (found := shutil.which(name))), None)


def make_screenshot_tool(folder: Path):
    """The same screenshot tool as 19_coding_agent.py, as an SDK tool: Chrome's own --screenshot, and the console
    messages Chrome prints to stderr. The result is a text block and an image block, which Claude sees."""
    @tool("screenshot", "Render an .html or .svg file from the project in headless Chrome and see it, with anything the "
          "page wrote to its console. Use it to check what only shows by eye: layout, charts, text cut off or "
          "overlapping. It shows the top of the page in a width × height window (default 1000 × 800).",
          {"type": "object", "properties": {"path": {"type": "string"}, "width": {"type": "integer"},
                                            "height": {"type": "integer"}}, "required": ["path"]})
    async def screenshot(args: dict[str, Any]) -> dict[str, Any]:
        page = (folder / args["path"]).resolve()
        if not page.is_relative_to(folder.resolve()) or page.suffix.lower() not in (".html", ".htm", ".svg") \
                or not page.is_file():
            return {"content": [{"type": "text", "text": "Give the path of an .html or .svg file in the project."}],
                    "is_error": True}
        if not (browser := chrome()):
            return {"content": [{"type": "text", "text": "No Chrome was found, so there is no screenshot."}], "is_error": True}
        width = min(max(int(args.get("width") or 1000), 400), 1600)
        height = min(max(int(args.get("height") or 800), 300), 2000)
        with tempfile.TemporaryDirectory(prefix="coding-agent-chrome-") as tmp:
            shot = Path(tmp) / "shot.png"
            proc = await asyncio.to_thread(subprocess.run, [
                browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                "--no-default-browser-check", "--disable-extensions", f"--user-data-dir={tmp}/profile",
                f"--window-size={width},{height}", "--virtual-time-budget=1500", "--enable-logging=stderr", "--v=0",
                f"--screenshot={shot}", page.as_uri()], capture_output=True, text=True, timeout=60)
            if not shot.exists():
                return {"content": [{"type": "text", "text": "Chrome did not produce a screenshot."}], "is_error": True}
            png = shot.read_bytes()
        console = [m.group(1)[:300] for m in re.finditer(r'CONSOLE[^\]]*\] "(.*)", source:', proc.stderr)][:20]
        rel = page.relative_to(folder.resolve()).as_posix()
        caption = f"{rel} in a {width}×{height} window, top of the page" + (
            "\nConsole:\n" + "\n".join(console) if console else "\nNothing in the console.")
        return {"content": [{"type": "text", "text": caption},
                            {"type": "image", "data": base64.b64encode(png).decode(), "mimeType": "image/png"}]}
    return screenshot


def images_in(content: Any) -> list[dict]:
    """The images in a tool result, from Read or from screenshot, for the lab page to show."""
    out = []
    for c in content if isinstance(content, list) else []:
        if isinstance(c, dict) and c.get("type") == "image":
            src = c.get("source") or {}
            data, media = src.get("data") or c.get("data"), src.get("media_type") or c.get("mimeType") or "image/png"
            if data:
                out.append({"media_type": media, "data": data})
    return out


def api_key() -> str:
    """ANTHROPIC_API_KEY from the environment, or from the lab's .env file."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    env = ROOT / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("Set ANTHROPIC_API_KEY, or put it in the lab's .env file.")


def new_project(into: Path | None) -> Path:
    folder = into or Path(tempfile.mkdtemp(prefix="coding-agent-sdk-")) / "project"
    shutil.copytree(PROJECT, folder, ignore=shutil.ignore_patterns("__pycache__"), dirs_exist_ok=True)
    if (folder / "CLAUDE.example.md").exists():
        (folder / "CLAUDE.example.md").rename(folder / "CLAUDE.md")
    if shutil.which("git"):  # its own repository, so git commands never reach one the folder sits inside
        git = ["git", "-c", "user.name=Coding agent lab", "-c", "user.email=lab@localhost", "-c", "commit.gpgsign=false"]
        for step in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "Starting point"]):
            subprocess.run([*git, *step], cwd=folder, capture_output=True, check=False)
    return folder


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prompt", nargs="?", help="your own request, instead of a task")
    parser.add_argument("--task", choices=list(TASKS), default="fix")
    parser.add_argument("--mode", choices=MODES, default="default")
    parser.add_argument("--model", default="claude-haiku-5-5")
    parser.add_argument("--budget", type=float, default=0.5, help="the SDK stops the run at this many dollars")
    parser.add_argument("--max-turns", type=int, default=30)
    parser.add_argument("--folder", type=Path, help="an existing copy of the project (made if it does not exist)")
    parser.add_argument("--json", action="store_true", help="one JSON event per line; approvals answered on stdin")
    parser.add_argument("--yes", action="store_true", help="approve every prompt without asking")
    args = parser.parse_args()

    folder = args.folder if args.folder and args.folder.exists() else new_project(args.folder)
    config = Path(tempfile.mkdtemp(prefix="claude-config-"))  # keeps your own ~/.claude out of the run
    options = ClaudeAgentOptions(
        cwd=str(folder),
        model=args.model,
        system_prompt={"type": "preset", "preset": "claude_code"},  # Claude Code's own system prompt
        tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "Task"],  # Task starts sub-agents
        agents={"explore": AgentDefinition(
            description="A read-only explorer with its own context. Use it for questions across many files.",
            prompt="Answer with Read, Glob and Grep, then reply in at most eight lines with file paths and line numbers.",
            tools=["Read", "Glob", "Grep"], model=args.model)},
        permission_mode="bypassPermissions" if args.mode == "auto" else args.mode,
        sandbox=SANDBOX if args.mode == "auto" else None,
        allowed_tools=ALLOW,
        disallowed_tools=AUTO_DENY if args.mode == "auto" else DENY,
        can_use_tool=make_permission_callback(folder, args.json, args.yes),
        mcp_servers={"lab": create_sdk_mcp_server("lab", tools=[make_screenshot_tool(folder)])},
        hooks={"PreToolUse": [HookMatcher(matcher="Write|Edit|Bash", hooks=[protect_files])],
               "PostToolUse": [HookMatcher(matcher="Write|Edit", hooks=[check_python])],
               "Stop": [HookMatcher(hooks=[make_stop_hook(folder, args.json)])]},
        setting_sources=["project"],
        max_turns=args.max_turns,
        max_budget_usd=args.budget,
        env={"ANTHROPIC_API_KEY": api_key(), "CLAUDE_CONFIG_DIR": str(config), "PYTHONDONTWRITEBYTECODE": "1",
             "GIT_CEILING_DIRECTORIES": str(folder.parent)},
    )
    prompt = args.prompt or TASKS[args.task]
    if not args.json:
        print(f"Project: {folder}\nMode: {args.mode}\nUser: {prompt}\n")
    names: dict[str, str] = {}
    try:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(prompt)
            async for msg in client.receive_response():
                depth = 1 if getattr(msg, "parent_tool_use_id", None) else 0
                who = "explore" if depth else "agent"
                if isinstance(msg, SystemMessage) and msg.subtype == "init":
                    emit({"type": "init", "tools": msg.data.get("tools", []), "model": msg.data.get("model"),
                          "mode": msg.data.get("permissionMode"), "cwd": msg.data.get("cwd")}, args.json)
                elif isinstance(msg, AssistantMessage):
                    for b in msg.content:
                        if isinstance(b, TextBlock) and b.text.strip():
                            emit({"type": "text", "who": who, "depth": depth, "text": b.text.strip()}, args.json)
                        elif isinstance(b, ToolUseBlock):
                            names[b.id] = b.name
                            emit({"type": "tool_use", "who": who, "depth": depth, "id": b.id, "name": b.name,
                                  "input": b.input}, args.json)
                            if b.name == "TodoWrite":
                                emit({"type": "todos", "todos": [{"content": t.get("content", ""), "status": t.get("status", "pending")}
                                                                 for t in b.input.get("todos", [])]}, args.json)
                elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
                    for b in msg.content:
                        if isinstance(b, ToolResultBlock):
                            content = b.content if isinstance(b.content, str) else "\n".join(
                                c.get("text", "") for c in b.content or [] if isinstance(c, dict))
                            images = images_in(b.content)
                            emit({"type": "result", "who": who, "depth": depth, "id": b.tool_use_id,
                                  "name": names.get(b.tool_use_id, ""), "content": (content or "")[:4000],
                                  "is_error": bool(b.is_error), **({"images": images} if images else {})}, args.json)
                elif isinstance(msg, ResultMessage):
                    emit({"type": "final", "answer": msg.result, "outcome": msg.subtype, "turns": msg.num_turns,
                          "cost": msg.total_cost_usd, "seconds": round(msg.duration_ms / 1000, 1),
                          "denials": len(msg.permission_denials or [])}, args.json)
                    if not args.json:
                        print(f"\nOutcome: {msg.subtype}. {msg.num_turns} turns, {msg.duration_ms / 1000:.1f} s, "
                              f"${msg.total_cost_usd or 0:.4f} (reported by the SDK).")
    finally:
        shutil.rmtree(config, ignore_errors=True)
    if not args.json:
        print(f"\nThe project is in {folder}")


if __name__ == "__main__":
    asyncio.run(main())
