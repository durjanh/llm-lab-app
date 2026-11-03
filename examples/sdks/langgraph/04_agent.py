"""Task 4, LangGraph: the harness is part of the graph.

    model --(tool calls)--> review --> tools --> model ... --> END

- review is a node that calls interrupt() for each write tool: the graph stops, saves its state in the
  checkpointer, and resumes with Command(resume=<the person's answer>). A rejected call is answered with a
  ToolMessage saying so, and the graph goes back to the model.
- tools is a ToolNode wrapped to print a trace line per call.
- recursion_limit is the step limit (LangGraph raises GraphRecursionError when it is reached).

    python 04_agent.py [--auto-approve]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from langchain_core.messages import SystemMessage, ToolMessage  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.graph import END, START, MessagesState, StateGraph  # noqa: E402
from langgraph.prebuilt import ToolNode, tools_condition  # noqa: E402
from langgraph.types import Command, interrupt  # noqa: E402
from shared import checks, engagements, tasks  # noqa: E402

tools = [tool(parse_docstring=True)(f) for f in engagements.ALL_TOOLS]
by_name = {t.name: t for t in tools}
model = llm().bind_tools(tools)
tool_node = ToolNode(tools)


def call_model(state: MessagesState) -> dict:
    return {"messages": [model.invoke([SystemMessage(tasks.SYSTEM), *state["messages"]])]}


def review(state: MessagesState) -> Command:
    calls = state["messages"][-1].tool_calls
    approved = {c["id"]: (c["name"] not in engagements.WRITE_TOOLS
                          or interrupt({"tool": c["name"], "args": c["args"]})) for c in calls}
    if all(approved.values()):
        return Command(goto="tools")
    # Some writes were declined: answer every call of this turn ourselves, then let the model continue.
    answers = []
    for c in calls:
        if approved[c["id"]]:
            print(f"  tool: {c['name']}({c['args']})")
            answers.append(ToolMessage(str(by_name[c["name"]].invoke(c["args"])), tool_call_id=c["id"]))
        else:
            answers.append(ToolMessage("A person declined this call. Do not retry it.", tool_call_id=c["id"]))
    return Command(goto="model", update={"messages": answers})


def run_tools(state: MessagesState) -> dict:
    for c in state["messages"][-1].tool_calls:
        print(f"  tool: {c['name']}({c['args']})")
    return tool_node.invoke(state)


builder = StateGraph(MessagesState)
builder.add_node("model", call_model)
builder.add_node("review", review, destinations=("tools", "model"))
builder.add_node("tools", run_tools)
builder.add_edge(START, "model")
builder.add_conditional_edges("model", tools_condition, {"tools": "review", END: END})
builder.add_edge("tools", "model")
graph = builder.compile(checkpointer=InMemorySaver())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auto-approve", action="store_true")
    args = parser.parse_args()
    run = {"configurable": {"thread_id": "task-4"}, "recursion_limit": 25}
    result = graph.invoke({"messages": [("user", tasks.GOAL)]}, run, version="v2")
    while result.interrupts:  # paused inside review: one interrupt per write call
        request = result.interrupts[0].value
        ok = checks.approve(request["tool"], request["args"], args.auto_approve)
        result = graph.invoke(Command(resume=ok), run, version="v2")
    print("\n" + result.value["messages"][-1].content)
    checks.agent_ok()


main()
