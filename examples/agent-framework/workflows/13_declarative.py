"""Declarative workflows: the workflow is a YAML file, and this program only loads it.

returns_desk.yaml holds the steps and the routing, with Power Fx expressions for the conditions. Use it when people
need to change a flow without a code release, or to review it as data. Avoid it for logic that is really code: the
expression language is small, and mistakes show up when the workflow runs, not when it compiles.

Power Fx isn't published for Python 3.14 and needs a .NET runtime, so this one has its own Python 3.12 environment:

    python3.12 -m venv .venv && .venv/bin/pip install -r requirements-declarative.txt
    .venv/bin/python 13_declarative.py
"""
from pathlib import Path

from _wf import Lab, drive, graph, main

TITLE = "Declarative (YAML)"
TASK = "Order PC-3017: my e-bike is the wrong size, so I would like to send it back."
FLOW = Path(__file__).parent / "returns_desk.yaml"
AGENTS = {
    "classifier": "Reply with one word only: SAFETY for anything about fire, injury or a dangerous fault, RETURN for "
                  "someone sending an item back, or OTHER.",
    "returns": "You handle returns. Our window is 30 days and collection is free. Say what happens next in under 40 words.",
    "general": "You answer general questions for a bike shop. Under 40 words.",
}


def load(lab: Lab):
    try:
        from agent_framework.declarative import WorkflowFactory
    except ImportError as exc:
        raise RuntimeError("This example needs its own environment: see requirements-declarative.txt.") from exc
    return WorkflowFactory(agents={name: lab.agent(name, prompt) for name, prompt in AGENTS.items()}).create_workflow_from_yaml_path(FLOW)


async def run(lab: Lab, task: str) -> None:
    workflow = load(lab)
    lab.trace.event("graph", **graph(workflow))
    await drive(workflow, {"message": task}, lab.trace)


if __name__ == "__main__":
    main(__file__)
