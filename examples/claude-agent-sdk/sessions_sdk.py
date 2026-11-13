"""Session management on the Claude Agent SDK: start, resume, fork and continue.

Every run of Claude Code is a session, stored on disk under the folder it ran in. The result message carries its
`session_id`, and ClaudeAgentOptions says what to do with one:

  session_id (from ResultMessage)   the handle to a session: keep it
  resume=<id>                       carry on that session: the same conversation, with all it had read still in context
  resume=<id>, fork_session=True    start a NEW session from where that one stood, and leave the original untouched
  continue_conversation=True        resume the most recent session in the folder, with no id to keep

The script reviews a small invented file, then:
  1. resumes the review to ask a follow-up (it remembers the file without reading it again),
  2. forks the review twice to try two ways of fixing the same problem from the same baseline, and
  3. continues the most recent session, which is the second fork.

    .venv/bin/python sessions_sdk.py                       # about ten cents with the default model
    .venv/bin/python sessions_sdk.py --model claude-sonnet-5-5
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, TextBlock

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = '''def find_customer(db, customer_ref):
    sql = f"SELECT * FROM customers WHERE ref = '{customer_ref}'"
    return db.execute(sql).fetchall()
'''
READ_ONLY = ["Read", "Glob", "Grep"]


def api_key() -> str:
    """ANTHROPIC_API_KEY from the environment, or from the lab's .env file."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    env = ROOT / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("Set ANTHROPIC_API_KEY, or put it in the lab's .env file.")


def make_options(folder: Path, config: Path, model: str, **session: object) -> ClaudeAgentOptions:
    """The same options for every step. `session` is the only part that changes: resume, fork_session or
    continue_conversation."""
    return ClaudeAgentOptions(
        cwd=str(folder),
        model=model,
        tools=READ_ONLY,
        allowed_tools=READ_ONLY,
        permission_mode="default",
        setting_sources=[],  # nothing from your own ~/.claude or the project: the run depends on this script only
        max_turns=8,
        max_budget_usd=0.25,
        env={"ANTHROPIC_API_KEY": api_key(), "CLAUDE_CONFIG_DIR": str(config)},  # sessions are stored in config
        **session,
    )


async def ask(options: ClaudeAgentOptions, prompt: str, label: str) -> str:
    """One turn: send the prompt, print the answer, and return the session_id from the result message."""
    session_id = ""
    async with ClaudeSDKClient(options=options) as client:
        await client.query(prompt)
        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock) and block.text.strip():
                        print(f"\n[{label}] {block.text.strip()}")
            elif isinstance(msg, ResultMessage):
                session_id = msg.session_id  # the handle to this session
                print(f"\n[{label}] session {session_id}, {msg.num_turns} turns, ${msg.total_cost_usd or 0:.4f}")
    return session_id


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="claude-haiku-5-5")
    args = parser.parse_args()

    folder = Path(tempfile.mkdtemp(prefix="sessions-sdk-"))
    config = Path(tempfile.mkdtemp(prefix="claude-config-"))
    (folder / "customers.py").write_text(SAMPLE)
    try:
        # 1. Start a session and keep its id.
        base = await ask(make_options(folder, config, args.model),
                         "Read customers.py and review it for security problems. Be brief.", "review")

        # 2. Resume it: the same conversation, so it already knows the file and its own finding.
        await ask(make_options(folder, config, args.model, resume=base),
                  "Which line would you change first? Answer in one sentence.", "resumed")

        # 3. Fork it twice from the same baseline. Each fork is a new session; `base` itself never changes.
        fix_a = await ask(make_options(folder, config, args.model, resume=base, fork_session=True),
                          "Show the fix using a parameterised query. Code only.", "fork A")
        fix_b = await ask(make_options(folder, config, args.model, resume=base, fork_session=True),
                          "Show the fix using an ORM query. Code only.", "fork B")
        print(f"\nBaseline {base}\nFork A   {fix_a}\nFork B   {fix_b}\n(three different ids: the baseline was not changed)")

        # 4. Continue the most recent session in this folder, with no id: that is fork B.
        await ask(make_options(folder, config, args.model, continue_conversation=True),
                  "Which approach did we just write, and what is its main risk? One sentence.", "continued")
    finally:
        shutil.rmtree(config, ignore_errors=True)
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
