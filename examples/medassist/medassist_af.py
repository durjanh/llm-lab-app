"""MedAssist on Microsoft Agent Framework: the same instructions, documents, database, rules and tests as medassist.py,
with the framework running the tool loop instead of our own.

medassist.py keeps the agent in Foundry (a prompt agent, with versions you can open in the portal) and runs the
function tools itself: clinic.run_turn reads each function_call and sends back a function_call_output. Here the
agent is defined in code, as an Agent on FoundryChatClient (the Responses API on your Foundry project), and the
framework does that loop: the clinic's methods become tools, and agent.run() calls them until there is a reply.
The rules do not move. They live in clinic.py, inside the tools, so they hold whichever loop calls them.

    python medassist_af.py chat                    # signed in as Valeria Romano; every tool call is shown
    python medassist_af.py chat --patient P003
    python medassist_af.py test                    # medassist.py's nine checked cases, on this version
    python medassist_af.py devui                   # DevUI at http://127.0.0.1:8091: each tool call, its result, traces

Needs `python medassist.py create` once first: this reuses its vector store of practice documents.
Reads FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL from the lab's .env; sign in with `az login`.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from agent_framework import Agent, AgentContext, AgentMiddleware, Content, tool
from agent_framework.foundry import FoundryChatClient
from azure.identity import DefaultAzureCredential

import clinic
import medassist  # the instructions, tests and settings: one copy for both versions

MAX_ITERATIONS = 6  # tool-calling rounds in one turn; medassist.py's MAX_ROUNDS
HOSTED = {"search_tool": "file_search", "code_interpreter": "code_interpreter"}  # content type fragment -> step name
DEVUI_PORT = 8091  # beside examples/agent-framework's DevUI on 8090


class NewTurn(AgentMiddleware):
    """Starts a new turn on the clinic session before every patient message, however the agent is called: by ask()
    below, or by DevUI, which calls the agent itself. The clinic's rules depend on it (a slot is booked only in a later
    turn than the one that showed it; a cancellation is confirmed in a later turn), so without it every booking made
    from DevUI would be refused. A new conversation (a new framework session: DevUI's "new conversation") starts the
    rules afresh: no slots shown, nothing waiting to be cancelled."""

    def __init__(self, session: clinic.Session):
        self.session = session
        self.conversation: object = None

    async def process(self, context: AgentContext, call_next) -> None:
        conversation = getattr(context.session, "session_id", None)
        if conversation != self.conversation:
            self.conversation = conversation
            self.session.turn = 0
            self.session.offered.clear()
            self.session.cancelling.clear()
        self.session.turn += 1
        await call_next()


def repeats_the_text(update) -> bool:
    """Whether a streamed update is Foundry's response.output_text.done event, which carries the whole text again
    after the pieces (the deltas) have already been streamed."""
    raw = getattr(update, "raw_representation", None)
    event = getattr(raw, "raw_representation", raw)
    return getattr(event, "type", "") == "response.output_text.done"


def without_repeated_text(update):
    """The update without its text when that text repeats what was already streamed; anything else is kept."""
    if repeats_the_text(update):
        update.contents = [c for c in update.contents if c.type != "text"]
    return update


def as_tool_call(content):
    """A hosted tool's step (File Search, the Code Interpreter) as a function call or result with the same id and name,
    which DevUI shows like any other tool. Marked informational: Foundry has already run it, so nothing runs it again."""
    name = getattr(content, "tool_name", None) or content.type.split("_tool_")[0]
    if content.type.endswith("_tool_call"):
        return Content.from_function_call(content.call_id, name, arguments=getattr(content, "arguments", None) or {},
                                          informational_only=True)
    return Content.from_function_result(content.call_id, result=getattr(content, "result", None))


def hosted_tools_as_calls(update):
    """The update with each hosted tool step shown as a tool call, rather than a content type DevUI does not know."""
    update.contents = [as_tool_call(c) if c.type.endswith(("_tool_call", "_tool_result")) and getattr(c, "call_id", None)
                       else c for c in update.contents]
    return update


class TidyStream(AgentMiddleware):
    """How a streamed reply reaches DevUI, which always streams. Two things, both only for streamed replies:
    - Agent Framework's Foundry client sends the text in pieces and then all of it again (response.output_text.done),
      so every reply would appear twice: the repeat is dropped.
    - File Search and the Code Interpreter arrive as content types DevUI does not know, which it shows as
      "Warning: Unknown content type": they are shown as tool calls with their results instead."""

    async def process(self, context: AgentContext, call_next) -> None:
        if context.stream:
            context.stream_update_transforms.extend([without_repeated_text, hosted_tools_as_calls])
        await call_next()


def knowledge_store() -> str:
    with medassist.project_client() as project:
        stores = medassist.stores_named(project.get_openai_client(), medassist.STORE)
    if not stores:
        sys.exit("No practice documents in Foundry yet: run python medassist.py create first.")
    return stores[0].id


def build(session: clinic.Session, store_id: str, steps: list[dict], name: str = "MedAssist") -> Agent:
    """MedAssist as an Agent Framework agent, for one signed-in patient. The clinic's methods are bound to that
    patient's session, so, as in medassist.py, no tool can be pointed at anyone else."""

    def function(name: str):
        """The clinic's tool for this session. It keeps each step, as clinic.run_turn does, for the trace and the tests."""
        def call(**args) -> dict:
            result = session.call(name, args)
            steps.append({"tool": name, "args": args, "result": result})
            medassist.print_step(steps[-1])
            return result
        return call

    tools = [FoundryChatClient.get_file_search_tool(vector_store_ids=[store_id]),
             FoundryChatClient.get_code_interpreter_tool()]
    # The same names, descriptions and JSON schemas the prompt agent has; the function is the clinic's method.
    tools += [tool(function(t["name"]), name=t["name"], description=t["description"], schema=t["parameters"])
              for t in clinic.FUNCTION_TOOLS]
    client = FoundryChatClient(project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"], model=os.environ["FOUNDRY_MODEL"],
                               credential=DefaultAzureCredential(),
                               function_invocation_configuration={"max_iterations": MAX_ITERATIONS})
    # The prompt agent gets the date and the signed-in patient as a developer message; here they join the instructions.
    return Agent(client=client, name=name, instructions=f"{medassist.INSTRUCTIONS}\n\n{clinic.portal_note(session)}",
                 description=f"Signed in as {session.patient['name']}", tools=tools, middleware=[NewTurn(session), TidyStream()])


def hosted_steps(response) -> list[str]:
    """File Search and the Code Interpreter run in Foundry, not through our tools: find them in the reply's contents."""
    found = []
    for message in response.messages:
        for content in message.contents:
            for fragment, name in HOSTED.items():
                if fragment in str(content.type) and name not in found:
                    found.append(name)
    return found


async def ask(agent: Agent, af_session, session: clinic.Session, text: str, steps: list[dict]) -> tuple[str, list[str]]:
    """One patient message: the reply, and the tools used. agent.run() does what clinic.run_turn does by hand."""
    start = len(steps)  # the turn itself is started by NewTurn, inside agent.run()
    response = await agent.run(text, session=af_session)
    used = hosted_steps(response) + [s["tool"] for s in steps[start:]]
    return response.text.strip(), used


async def chat(args) -> None:
    if not medassist.DATABASE.exists():
        clinic.create_database(medassist.DATABASE)
    session = clinic.Session(medassist.DATABASE, args.patient)
    steps: list[dict] = []
    agent = build(session, knowledge_store(), steps)
    af_session = agent.create_session()
    print(f"MedAssist on Agent Framework · signed in as {session.patient['name']}. Empty line to finish.\n")
    while text := input("You: ").strip():
        reply, _ = await ask(agent, af_session, session, text, steps)
        print(f"\nMedAssist: {reply}\n")


async def test(args) -> None:
    store_id = knowledge_store()
    passed = 0
    for name, messages, check in medassist.TESTS:
        print(f"\n=== {name} ===")
        clinic.create_database(medassist.TEST_DATABASE)
        session = clinic.Session(medassist.TEST_DATABASE, "P001")
        steps: list[dict] = []
        agent = build(session, store_id, steps)
        af_session = agent.create_session()
        turns: list[list[str]] = []
        for text in messages:
            print(f"You: {text}")
            reply, used = await ask(agent, af_session, session, text, steps)
            turns.append(used)
            print(f"MedAssist: {reply}\n")
        ok = check(reply, turns, session)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'}: {name} (tools by turn: {turns})")
    print(f"\n{passed} of {len(medassist.TESTS)} passed on Agent Framework. Model replies vary: run it more than once.")


def devui_agents() -> list[Agent]:
    """MedAssist for DevUI: one agent per patient, each signed in as that patient on the shared practice database,
    so the selector says who you are. Two DevUI conversations as the same patient share that patient's session."""
    if not medassist.DATABASE.exists():
        clinic.create_database(medassist.DATABASE)
    store_id = knowledge_store()
    return [build(clinic.Session(medassist.DATABASE, pid), store_id, [], name=f"MedAssist ({name})")
            for pid, name, *_ in clinic.PATIENTS]


def devui(args) -> None:
    """DevUI for MedAssist: chat as any patient and watch each tool call, its arguments and result, and the traces."""
    from agent_framework.devui import serve
    port = int(os.environ.get("DEVUI_PORT", DEVUI_PORT))
    print(f"MedAssist in DevUI at http://127.0.0.1:{port}: choose a patient at the top. The records change in "
          "examples/medassist/data/medassist.db, which the lab's MedAssist page shows.")
    # Local only: DevUI binds to 127.0.0.1, so its token auth is switched off for convenience.
    serve(entities=devui_agents(), port=port, host="127.0.0.1", auto_open=False, instrumentation_enabled=True,
          auth_enabled=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["chat", "test", "devui"])
    parser.add_argument("--patient", default="P001", choices=[p[0] for p in clinic.PATIENTS])
    args = parser.parse_args()
    if args.command == "devui":  # DevUI runs its own server and event loop
        return devui(args)
    asyncio.run({"chat": chat, "test": test}[args.command](args))


if __name__ == "__main__":
    main()
