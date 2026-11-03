"""What the example agents share: each is a Microsoft Foundry prompt agent whose function tools run on this machine,
against its own dummy SQLite database, with the rules that matter enforced in code.

The model decides which tools to call and in what order. The tools decide what is allowed. A prompt is a request
the model follows most of the time, so anything that sends, books or changes data is checked here, every time:

- `ToolSession.offer` and `ToolSession.chosen`: a choice (a slot, say) can be acted on only in a later turn than
  the one that showed it, so the person has seen the options and picked one.
- `ToolSession.confirm`: an action with consequences (sending an email) takes two calls in two turns; the first
  only returns what would happen and asks for a yes.
- `ToolSession.audit`: every change is logged.

The loop (`run_turn`) is the same one examples/medassist uses: the agent returns function calls, this code runs
them and sends back the results, until the agent answers in words. Each agent module defines an `AgentSpec`;
run them with run.py.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"  # the dummy databases; ignored by git
AUDIT_TABLE = "CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT, action TEXT, detail TEXT);"


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def tool(name: str, description: str, properties: dict) -> dict:
    """A strict function tool: every property is required (use "" or [] for "none"), nothing else is accepted."""
    return {"type": "function", "name": name, "description": description, "strict": True,
            "parameters": {"type": "object", "properties": properties, "required": list(properties),
                           "additionalProperties": False}}


def fresh_database(path: Path, schema: str) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.executescript(schema + AUDIT_TABLE)
    return db


class ToolSession:
    """One conversation's view of an agent's systems. Subclasses add the tool methods and name them in TOOLS."""
    TOOLS: tuple[str, ...] = ()

    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.turn = 0  # the person's message number; run_turn adds one per message
        self.offered: dict[str, int] = {}  # option id -> the turn it was shown
        self.pending: dict[str, int] = {}  # action key -> the turn confirmation was asked
        self.read: set[str] = set()  # ids of things the agent has read this conversation

    def note(self) -> str:
        """What the app tells the agent at the start: the date, and who is signed in."""
        return f"Today is {date.today():%A %d %B %Y} ({date.today().isoformat()}), time {datetime.now():%H:%M}, Europe/London."

    def rows(self, sql: str, params: tuple = ()) -> list[dict]:
        return [dict(r) for r in self.db.execute(sql, params).fetchall()]

    def audit(self, action: str, detail: str = "") -> None:
        self.db.execute("INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)", (now(), action, detail))
        self.db.commit()

    def offer(self, ids: list[str]) -> None:
        for i in ids:
            self.offered.setdefault(i, self.turn)

    def chosen(self, option: str) -> str | None:
        """None if the person has seen this option and chosen it; otherwise the reason it cannot be used yet."""
        if option not in self.offered:
            return "Use only an option the search tool returned in this conversation."
        if self.offered[option] == self.turn:
            return "Not done: the person has not seen these options yet. Show them as a numbered list and wait for a choice."
        return None

    def shown(self, key: str) -> None:
        """Mark an action as put to the person now (a draft they will see), so it may go ahead from their next turn."""
        self.pending.setdefault(key, self.turn)

    def confirm(self, key: str, preview: dict) -> dict | None:
        """None when the person has already been asked about this action, in an earlier turn; otherwise asks them."""
        if self.pending.get(key, self.turn) == self.turn:
            self.pending[key] = self.turn
            return {"done": False, "confirm_first": "Show the person exactly this and ask them to confirm. Call the "
                                                    "tool again with the same arguments after they say yes.",
                    "preview": preview}
        return None

    def call(self, name: str, args: dict) -> dict:
        if name not in self.TOOLS:
            return {"error": f"There is no tool called {name}."}
        try:
            return getattr(self, name)(**args)
        except TypeError as exc:  # wrong or missing arguments
            return {"error": f"Bad arguments for {name}: {exc}"}


@dataclass
class AgentSpec:
    key: str  # sales, research, planner
    name: str  # the agent's name in Foundry
    description: str
    instructions: str
    tools: list[dict]
    create_database: Callable[[Path], None]
    session: Callable[[Path], ToolSession]
    tests: list[tuple[str, list[str], Callable[[str, list[list[str]], Any], bool]]]
    records: Callable[[Path], None]
    knowledge: Path | None = None  # a folder of documents for File Search
    code_interpreter: bool = False
    starters: list[str] = field(default_factory=list)  # things to try in chat


def reply_text(response) -> str:
    """The reply's text. The model sometimes sends the same message item twice; show it once."""
    parts: list[str] = []
    for item in response.output:
        if item.type == "message":
            text = "".join(c.text for c in item.content if c.type == "output_text").strip()
            if text and text not in parts:
                parts.append(text)
    return "\n\n".join(parts)


def run_turn(respond: Callable[[object], object], session: ToolSession, text: str, max_rounds: int = 8,
             on_step: Callable[[dict], None] = lambda step: None) -> tuple[str, list[dict]]:
    """One message, through to the agent's reply. Foundry runs File Search and the Code Interpreter and reports them;
    function calls come back here, run against the session, and their results go back, round after round."""
    session.turn += 1
    steps: list[dict] = []
    response = respond(text)
    for _ in range(max_rounds):
        outputs = []
        for item in response.output:
            step = None
            if item.type == "file_search_call":
                step = {"tool": "file_search", "queries": list(item.queries or [])}
            elif item.type == "code_interpreter_call":
                step = {"tool": "code_interpreter", "code": item.code or ""}
            elif item.type == "function_call":
                try:
                    args = json.loads(item.arguments)
                    result = session.call(item.name, args)
                except json.JSONDecodeError:
                    args, result = item.arguments, {"error": "The arguments were not valid JSON."}
                step = {"tool": item.name, "args": args, "result": result}
                outputs.append({"type": "function_call_output", "call_id": item.call_id,
                                "output": json.dumps(result, default=str)})
            if step:
                steps.append(step)
                on_step(step)
        if not outputs:
            return reply_text(response), steps
        response = respond(outputs)
    return "(Stopped: too many tool calls in one turn.)", steps


def print_step(step: dict) -> None:
    if step["tool"] == "file_search":
        print(f"  [file search] {'; '.join(step['queries'])}")
    elif step["tool"] == "code_interpreter":
        print("  [code interpreter]\n" + "\n".join(f"    {line}" for line in step["code"].splitlines()))
    else:
        print(f"  [{step['tool']}] {json.dumps(step['args'])}\n    -> {json.dumps(step['result'], default=str)[:400]}")


# ---------------------------------------------------------------- Foundry: create, chat, test, delete

def project_client():
    from azure.ai.projects import AIProjectClient
    from azure.identity import DefaultAzureCredential
    from dotenv import load_dotenv

    load_dotenv(HERE.parents[1] / ".env")
    if not os.environ.get("FOUNDRY_PROJECT_ENDPOINT") or not os.environ.get("FOUNDRY_MODEL"):
        sys.exit("Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL in the lab's .env, and run az login.")
    return AIProjectClient(endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"], credential=DefaultAzureCredential())


def store_name(spec: AgentSpec) -> str:
    return f"{spec.name.lower()}-knowledge"


def stores_named(openai, name: str) -> list:
    return [s for s in openai.vector_stores.list(limit=100) if s.name == name]


def delete_store(openai, store) -> None:
    for f in openai.vector_stores.files.list(vector_store_id=store.id, limit=100):
        openai.files.delete(f.id)
    openai.vector_stores.delete(store.id)


def create(spec: AgentSpec) -> None:
    from azure.ai.projects.models import CodeInterpreterTool, FileSearchTool, FunctionTool, PromptAgentDefinition

    with project_client() as project:
        openai = project.get_openai_client()
        tools: list = []
        if spec.knowledge:
            for old in stores_named(openai, store_name(spec)):
                delete_store(openai, old)
            store = openai.vector_stores.create(name=store_name(spec))
            docs = sorted(spec.knowledge.glob("*.md"))
            batch = openai.vector_stores.file_batches.upload_and_poll(vector_store_id=store.id,
                                                                     files=[d.open("rb") for d in docs])
            print(f"Indexed {batch.file_counts.completed} of {len(docs)} documents in vector store {store.id}")
            tools.append(FileSearchTool(vector_store_ids=[store.id]))
        if spec.code_interpreter:
            tools.append(CodeInterpreterTool())
        tools += [FunctionTool(**{k: v for k, v in t.items() if k != "type"}) for t in spec.tools]
        agent = project.agents.create_version(
            agent_name=spec.name, description=spec.description,
            definition=PromptAgentDefinition(model=os.environ["FOUNDRY_MODEL"], instructions=spec.instructions,
                                             tools=tools))
        print(f"Saved {agent.name} version {agent.version} in your Foundry project.")


def delete(spec: AgentSpec) -> None:
    with project_client() as project:
        openai = project.get_openai_client()
        try:
            project.agents.delete(agent_name=spec.name)
            print(f"Deleted {spec.name} and all its versions.")
        except Exception as exc:  # already gone
            print(f"{spec.name}: {exc}")
        for store in stores_named(openai, store_name(spec)):
            delete_store(openai, store)
            print(f"Deleted vector store {store.id} and its files.")


def conversation(openai, session: ToolSession) -> str:
    return openai.conversations.create(items=[{"type": "message", "role": "developer", "content": session.note()}]).id


def ask(openai, spec: AgentSpec, conv: str, session: ToolSession, text: str, show=print_step) -> tuple[str, list[str]]:
    agent = {"agent_reference": {"name": spec.name, "type": "agent_reference"}}
    reply, steps = run_turn(lambda input: openai.responses.create(conversation=conv, input=input, extra_body=agent),
                            session, text, on_step=show)
    return reply, [s["tool"] for s in steps]


def chat(spec: AgentSpec) -> None:
    path = DATA / f"{spec.key}.db"
    if not path.exists():
        spec.create_database(path)
    session = spec.session(path)
    with project_client() as project:
        openai = project.get_openai_client()
        conv = conversation(openai, session)
        print(f"{spec.name}. {session.note()}\nTry: " + " · ".join(f'"{s}"' for s in spec.starters) + "\nEmpty line to finish.\n")
        try:
            while text := input("You: ").strip():
                reply, _ = ask(openai, spec, conv, session, text)
                print(f"\n{spec.name}: {reply}\n")
        finally:
            openai.conversations.delete(conv)


def test(spec: AgentSpec, only: list[int] | None = None) -> int:
    """Each case on a fresh database; the check looks at what really changed there, not only at the reply."""
    passed = run = 0
    path = DATA / f"{spec.key}-test.db"
    with project_client() as project:
        openai = project.get_openai_client()
        for n, (name, messages, check) in enumerate(spec.tests, 1):
            if only and n not in only:
                continue
            run += 1
            print(f"\n=== {n}. {name} ===")
            spec.create_database(path)
            session = spec.session(path)
            conv = conversation(openai, session)
            turns: list[list[str]] = []
            reply = ""
            try:
                for text in messages:
                    print(f"You: {text}")
                    reply, used = ask(openai, spec, conv, session, text)
                    turns.append(used)
                    print(f"{spec.name}: {reply}\n")
            finally:
                openai.conversations.delete(conv)
            ok = bool(check(reply, turns, session))
            passed += ok
            print(f"{'PASS' if ok else 'FAIL'}: {name} (tools by turn: {turns})")
    path.unlink(missing_ok=True)
    print(f"\n{spec.name}: {passed} of {run} passed. Model replies vary: run it more than once before trusting a change.")
    return passed
