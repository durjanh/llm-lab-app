"""Task 5, LangGraph: a multi-agent graph. The researcher is itself a compiled agent graph (with the tools), used
as a node of the outer graph; its findings go into the shared state, and the writer node turns them into the
update.  START -> researcher -> writer -> END"""
import sys
from pathlib import Path
from typing import TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from graph_parts import agent_graph  # noqa: E402
from langchain_core.messages import SystemMessage  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402
from shared import checks, engagements, tasks  # noqa: E402

model = llm()
researcher_graph = agent_graph(model, [tool(parse_docstring=True)(f) for f in engagements.READ_TOOLS], tasks.RESEARCHER)


class Team(TypedDict, total=False):
    brief: str
    facts: str
    update: str


def researcher(state: Team) -> Team:
    print("  -> researcher")
    out = researcher_graph.invoke({"messages": [("user", f"Gather the facts for this, including the client's name: {state['brief']}")]},
                                  {"recursion_limit": 12})
    return {"facts": out["messages"][-1].content}


def writer(state: Team) -> Team:
    print("  -> writer")
    reply = model.invoke([SystemMessage(tasks.WRITER), ("user", f"{state['brief']}\n\nFacts:\n{state['facts']}")])
    return {"update": reply.content}


team = (StateGraph(Team).add_node("researcher", researcher).add_node("writer", writer)
        .add_edge(START, "researcher").add_edge("researcher", "writer").add_edge("writer", END).compile())
result = team.invoke({"brief": tasks.UPDATE_BRIEF})
print(result["update"])
checks.update_ok(result["update"])
