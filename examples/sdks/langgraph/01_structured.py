"""Task 1, LangGraph: the smallest graph. A typed state, one node that calls the model with structured output,
and START -> triage -> END. LangGraph adds nothing to a single call; this just shows the building blocks."""
import sys
from pathlib import Path
from typing import TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402
from shared import checks, tasks  # noqa: E402


class State(TypedDict, total=False):
    complaint: str
    triage: tasks.Triage


def triage(state: State) -> State:
    return {"triage": llm().with_structured_output(tasks.Triage).invoke(f"Triage this housing complaint:\n\n{state['complaint']}")}


graph = StateGraph(State).add_node("triage", triage).add_edge(START, "triage").add_edge("triage", END).compile()
result = graph.invoke({"complaint": tasks.COMPLAINT})
print(result["triage"])
checks.triage_ok(result["triage"])
