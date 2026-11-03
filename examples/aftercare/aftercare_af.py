"""Aftercare on Microsoft Agent Framework: the same records, rules, tools and simulated patients as aftercare.py,
with the framework running the tool loop on your Foundry model instead of ours running it on Claude.

aftercare.py sends each Messages API request itself and runs every tool_use block against the call
(ward.claude_turn). Here the agent is an Agent on FoundryChatClient (the Responses API on your Foundry project),
and agent.run() calls the tools until there is a reply. The rules do not move: they live in ward.py, inside
the tools, so they hold whichever loop calls them.

    python aftercare_af.py chat                      # you are Margaret Bell; every tool call is shown
    python aftercare_af.py test                      # the eight simulated patients, on this version
    python aftercare_af.py test --patients P103 P105

Reads FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL from the lab's .env; sign in with `az login`. The simulated
patient is still Claude Haiku (ANTHROPIC_API_KEY), so both versions face the same patients.
"""
from __future__ import annotations

import argparse
import asyncio
import os

import anthropic
from agent_framework import Agent, tool
from agent_framework.foundry import FoundryChatClient
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

import aftercare
import ward

MAX_ITERATIONS = 8  # tool-calling rounds in one turn; ward.claude_turn's max_rounds
TEST_DATABASE = aftercare.HERE / "data" / "test-af.db"  # its own, so both versions can be tested at once


def build(call: ward.Call, steps: list[dict]) -> Agent:
    """The Aftercare agent for one call. Each tool is the call's method, so no tool can reach another patient."""

    def function(name: str):
        def run(**args) -> dict:
            result = call.call(name, args)
            steps.append({"tool": name, "args": args, "result": result})
            return result
        return run

    tools = [tool(function(t["name"]), name=t["name"], description=t["description"], schema=t["parameters"])
             for t in ward.TOOLS]
    client = FoundryChatClient(project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"], model=os.environ["FOUNDRY_MODEL"],
                               credential=DefaultAzureCredential(),
                               function_invocation_configuration={"max_iterations": MAX_ITERATIONS})
    return Agent(client=client, name="Aftercare", instructions=ward.INSTRUCTIONS, tools=tools)


def reply_text(response) -> str:
    """The reply's text, each distinct piece once. response.text runs the pieces together, and the model sometimes
    sends the same text twice."""
    parts: list[str] = []
    for message in response.messages:
        for content in message.contents:
            text = (getattr(content, "text", None) or "").strip() if content.type == "text" else ""
            if text and text not in parts:
                parts.append(text)
    return "\n\n".join(parts)


class Turns:
    """agent(text) -> (reply, steps) for ward.play, on one Agent Framework session (which keeps the history)."""

    def __init__(self, call: ward.Call, loop: asyncio.AbstractEventLoop):
        self.steps: list[dict] = []
        self.agent = build(call, self.steps)
        self.session = self.agent.create_session()
        self.loop = loop
        self.tokens = [0, 0]

    def __call__(self, text: str) -> tuple[str, list[dict]]:
        start = len(self.steps)
        response = self.loop.run_until_complete(self.agent.run(text, session=self.session))
        u = response.usage_details or {}
        self.tokens[0] += u.get("input_token_count") or 0
        self.tokens[1] += u.get("output_token_count") or 0
        return reply_text(response), self.steps[start:]


def chat(args) -> None:
    if not aftercare.DATABASE.exists():
        ward.create_database(aftercare.DATABASE)
    call = ward.Call(aftercare.DATABASE, args.patient, engine="agent-framework")
    loop = asyncio.new_event_loop()
    turn = Turns(call, loop)
    print(f"Aftercare on Agent Framework ({os.environ['FOUNDRY_MODEL']}), wave {call.wave}, for "
          f"{call.patient['name']}. Empty line to stop.\n")
    reply, steps = turn(call.opening_note())
    aftercare.print_steps(steps)
    print(f"Agent: {call.agent_output(reply)}\n")
    while not call.done and (text := input("You: ").strip()):
        reply, steps = turn(call.patient_input(text))
        aftercare.print_steps(steps)
        print(f"\nAgent: {call.agent_output(reply)}\n")
    print(f"Record: {ward.record(aftercare.DATABASE, args.patient)['outreach'][0]['status']}. "
          f"{turn.tokens[0]:,} input and {turn.tokens[1]:,} output tokens.")


def test(args) -> None:
    ward.create_database(TEST_DATABASE)
    claude = anthropic.Anthropic()
    loop = asyncio.new_event_loop()
    passed = total = 0
    for pid in args.patients:
        call = ward.Call(TEST_DATABASE, pid, engine="agent-framework")
        print(f"\n=== {pid} {call.patient['name']}: wave {call.wave}, {call.patient['channel']}, "
              f"{ward.LANGUAGES[call.language]} ===")
        patient = lambda c: ward.simulate_patient(claude.messages.create, c, aftercare.PATIENT_MODEL)

        def show(e: dict) -> None:
            aftercare.print_steps(e.get("steps", []))
            print(f"{'Agent' if e['speaker'] == 'agent' else 'Patient'}: {e['text']}")

        checks = ward.play(call, Turns(call, loop), patient, on_event=show)
        for c in checks:
            print(f"{'PASS' if c['passed'] else 'FAIL'}: {c['check']}")
        passed += sum(c["passed"] for c in checks)
        total += len(checks)
    print(f"\n{passed} of {total} checks passed on Agent Framework with {os.environ['FOUNDRY_MODEL']}. "
          "Replies vary: run it more than once.")


def main() -> None:
    load_dotenv(aftercare.HERE.parent.parent / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["chat", "test"])
    parser.add_argument("--patient", default="P101", choices=list(ward.BY_ID))
    parser.add_argument("--patients", nargs="+", default=list(ward.PERSONAS), choices=list(ward.PERSONAS))
    args = parser.parse_args()
    {"chat": chat, "test": test}[args.command](args)


if __name__ == "__main__":
    main()
