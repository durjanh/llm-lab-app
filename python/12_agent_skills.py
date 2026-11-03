"""Agent Skills: Claude reads a skill's instructions only when a task needs them, then runs its code.

Companion to the Harness engineering lab and the Skills chapter of the Inside Claude Code lab.
A skill is a folder holding a SKILL.md (a name, a description, then instructions) and any
scripts it needs. Only the name and description sit in Claude's context from the start. When a
task matches, Claude reads the rest and runs the scripts in Anthropic's code-execution
container. Files it makes come back as file IDs, which this script downloads with the Files API.

Two kinds of skill:
  anthropic  Anthropic's own: xlsx, pptx, docx and pdf. Nothing to upload.
  custom     Your own. --custom uploads python/skills/number-profile once, reuses it on later
             runs, and gives Claude both it and the Anthropic skill.

    python 12_agent_skills.py                          # a spreadsheet of the numbers 2 to 20, with a chart
    python 12_agent_skills.py --skill pptx --upto 30   # a short slide deck instead
    python 12_agent_skills.py --custom                 # also use your own number-profile skill
    python 12_agent_skills.py --custom --cleanup       # and delete that custom skill afterwards
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from anthropic.lib import files_from_dir

from common import cost_usd, create, describe_usage, ensure_answered, make_client, model_argument, run

CODE_EXECUTION = {"type": "code_execution_20250825", "name": "code_execution"}  # skills run inside it
SKILL_DIR = Path(__file__).resolve().parent / "skills" / "number-profile"
TASKS = {
    "xlsx": "Make an Excel workbook of the whole numbers 2 to {upto}, with the columns number, prime (yes or no), "
            "prime factors and digit sum, and a bar chart of the digit sums. Save it as numbers.xlsx.",
    "pptx": "Make a four-slide presentation called 'Prime numbers up to {upto}': a title slide, what a prime is, "
            "a table of the primes up to {upto}, and one surprising fact about them. Save it as primes.pptx.",
    "docx": "Write a one-page Word report on the whole numbers 2 to {upto}: which are prime, which has the most "
            "divisors, and a table of prime factors. Save it as numbers.docx.",
    "pdf": "Make a one-page PDF fact sheet on the prime numbers up to {upto}, with a table of them. "
           "Save it as primes.pdf.",
}
CUSTOM_HINT = " Work the numbers out with the number-profile skill rather than by yourself."


def custom_skill(client) -> str:
    """The id of your number-profile skill, uploading it the first time."""
    for skill in client.skills.list(source="custom"):
        if skill.display_name == SKILL_DIR.name:
            print(f"Reusing your custom skill {skill.id}. To upload local changes, run once with --cleanup first.")
            return skill.id
    files = [f for f in files_from_dir(SKILL_DIR) if "__pycache__" not in str(f[0])]  # no local build output
    skill = client.skills.create(files=files, display_name=SKILL_DIR.name)
    print(f"Uploaded {SKILL_DIR.name} as custom skill {skill.id} (version {skill.latest_version_id}). "
          "Custom skills are shared with everyone in your workspace.")
    return skill.id


def delete_skill(client, skill_id: str) -> None:
    for version in client.skills.versions.list(skill_id):  # a skill can only be deleted once it has no versions
        client.skills.versions.delete(version.id, skill_id=skill_id)
    client.skills.delete(skill_id)
    print(f"Deleted custom skill {skill_id}.")


def print_event(e: dict) -> None:
    """Shows one step in the terminal. The lab backend streams the same events to the page instead."""
    kind = e["type"]
    if kind == "request":
        print(f"[request {e['turn']} · stop_reason={e['stop_reason']} · {e['usage']}]")
    elif kind == "says":
        print(f"  Claude: {e['text']}")
    elif kind == "step":
        print(f"  ⇢ {e['name']}: {e['detail']}")
    elif kind == "output":
        print(f"    exit {e['return_code']}" + (f" · {e['first_line']}" if e["first_line"] else ""))
    elif kind in ("error", "paused"):
        print(f"    {e['text']}")


def report(resp, emit: Callable[[dict], None]) -> list[str]:
    """Reports what Claude did in the container, and returns the ids of any files it made."""
    file_ids = []
    for block in resp.content:
        if block.type == "text" and block.text.strip():
            emit({"type": "says", "text": block.text.strip()})
        elif block.type == "server_tool_use":
            detail = " ".join(str(block.input[k]) for k in ("command", "path") if block.input.get(k))
            emit({"type": "step", "name": block.name, "detail": detail.splitlines()[0][:110] if detail else ""})
        elif block.type == "bash_code_execution_tool_result":
            result = block.content
            if result.type != "bash_code_execution_result":
                emit({"type": "error", "text": f"error: {getattr(result, 'error_code', result.type)}"})
                continue
            output = (result.stdout or result.stderr or "").strip()
            emit({"type": "output", "return_code": result.return_code,
                  "first_line": output.splitlines()[0][:100] if output else ""})
            file_ids += [f.file_id for f in result.content if f.type == "bash_code_execution_output"]
    return file_ids


@dataclass
class SkillsResult:
    file_ids: list[str]           # files made in this turn
    cost: float                   # token cost of this turn
    messages: list[dict]          # the whole conversation, ready for a follow-up message
    container_id: str | None      # pass it back so files from earlier turns are still there


def run_with_skills(client, model: str, skills: list[dict], task: str | list[dict], max_continuations: int = 5,
                    emit: Callable[[dict], None] = print_event, on_response: Callable | None = None,
                    cancelled: Callable[[], bool] = lambda: False, *, history: list[dict] | None = None,
                    container_id: str | None = None, system: str | None = None) -> SkillsResult:
    """Runs one user turn with skills, resuming paused turns.

    `task` is the user's message: text, or content blocks such as container_upload files.
    To continue a conversation, pass the previous result's messages as `history` and its container_id.
    """
    messages: list[dict] = [*(history or []), {"role": "user", "content": task}]
    file_ids, total = [], 0.0
    for attempt in range(max_continuations + 1):
        if cancelled():
            break
        params = {"model": model, "max_tokens": 16000, "tools": [CODE_EXECUTION], "messages": messages,
                  "container": {"skills": skills, **({"id": container_id} if container_id else {})}}
        if system:
            params["system"] = system
        resp = create(client, **params)
        ensure_answered(resp)
        cost = cost_usd(resp.usage, model) or 0
        total += cost
        if on_response:
            on_response(resp)
        emit({"type": "request", "turn": attempt + 1, "stop_reason": resp.stop_reason,
              "usage": describe_usage(resp.usage, model), "cost": cost})
        file_ids += report(resp, emit)
        # Keep the reply, and the container, so a paused turn can resume and a follow-up can build on it.
        messages.append({"role": "assistant", "content": resp.content})
        container_id = getattr(getattr(resp, "container", None), "id", None) or container_id
        if resp.stop_reason != "pause_turn":
            return SkillsResult(file_ids, total, messages, container_id)
    else:
        emit({"type": "paused", "text": f"Still paused after {max_continuations} continuations. "
                                        "Raise --max-continuations to let it finish."})
    return SkillsResult(file_ids, total, messages, container_id)


def download(client, file_ids: list[str], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for file_id in dict.fromkeys(file_ids):
        name = Path(client.files.retrieve_metadata(file_id).filename).name  # never trust a path from outside
        if name in ("", ".", ".."):
            continue
        path = out_dir / name
        client.files.download(file_id).write_to_file(path)
        print(f"Saved {path} ({path.stat().st_size:,} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skill", choices=list(TASKS), default="xlsx", help="which Anthropic skill to use")
    parser.add_argument("--upto", type=int, default=20, help="the numbers to cover, from 2 up to this")
    parser.add_argument("--custom", action="store_true", help="also upload and use the number-profile skill")
    parser.add_argument("--cleanup", action="store_true", help="delete the custom skill when finished")
    parser.add_argument("--out", type=Path, default=Path("skill_outputs"), help="folder for the files Claude makes")
    parser.add_argument("--max-continuations", type=int, default=5, help="how often to resume a paused turn")
    model_argument(parser)
    args = parser.parse_args()
    client = make_client()

    skills = [{"type": "anthropic", "skill_id": args.skill, "version": "latest"}]
    custom_id = custom_skill(client) if args.custom else None
    if custom_id:
        skills.append({"type": "custom", "skill_id": custom_id, "version": "latest"})
    task = TASKS[args.skill].format(upto=args.upto) + (CUSTOM_HINT if custom_id else "")
    print(f"Skills offered: {', '.join(s['skill_id'] for s in skills)}\nUser: {task}\n")

    try:
        result = run_with_skills(client, args.model, skills, task, args.max_continuations)
        file_ids, total = result.file_ids, result.cost
        print()
        if file_ids:
            download(client, file_ids, args.out)
        else:
            print("Claude made no files this time.")
    finally:
        if custom_id and args.cleanup:
            delete_skill(client, custom_id)
    print(f"\nEstimated token cost: ${total:.4f}. Code-execution container time is billed separately.")


if __name__ == "__main__":
    run(main)
