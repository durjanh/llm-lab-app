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

Needs `python medassist.py create` once first: this reuses its vector store of practice documents.
Reads FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL from the lab's .env; sign in with `az login`.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from agent_framework import Agent, tool
from agent_framework.foundry import FoundryChatClient
from azure.identity import DefaultAzureCredential

import clinic
import medassist  # the instructions, tests and settings: one copy for both versions

MAX_ITERATIONS = 6  # tool-calling rounds in one turn; medassist.py's MAX_ROUNDS
HOSTED = {"search_tool": "file_search", "code_interpreter": "code_interpreter"}  # content type fragment -> step name


def knowledge_store() -> str:
    with medassist.project_client() as project:
        stores = medassist.stores_named(project.get_openai_client(), medassist.STORE)
    if not stores:
        sys.exit("No practice documents in Foundry yet: run python medassist.py create first.")
    return stores[0].id


def build(session: clinic.Session, store_id: str, steps: list[dict]) -> Agent:
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
    return Agent(client=client, name="MedAssist", instructions=f"{medassist.INSTRUCTIONS}\n\n{clinic.portal_note(session)}",
                 tools=tools)


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
    session.turn += 1  # the clinic's rules depend on which turn things happened in
    start = len(steps)
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["chat", "test"])
    parser.add_argument("--patient", default="P001", choices=[p[0] for p in clinic.PATIENTS])
    args = parser.parse_args()
    asyncio.run({"chat": chat, "test": test}[args.command](args))


if __name__ == "__main__":
    main()
