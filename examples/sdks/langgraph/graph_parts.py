"""The agent loop as an explicit graph, shared by tasks 2 to 5: a model node that may ask for tools, a ToolNode
that runs them, and a conditional edge (tools_condition) that loops back until the model answers."""
from __future__ import annotations

from langchain_core.messages import SystemMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition


def agent_graph(model, tools, system: str, **compile_args):
    bound = model.bind_tools(tools)

    def call_model(state: MessagesState) -> dict:
        return {"messages": [bound.invoke([SystemMessage(system), *state["messages"]])]}

    builder = StateGraph(MessagesState)
    builder.add_node("model", call_model)
    builder.add_node("tools", ToolNode(tools))
    builder.add_edge(START, "model")
    builder.add_conditional_edges("model", tools_condition, {"tools": "tools", END: END})
    builder.add_edge("tools", "model")
    return builder.compile(**compile_args)
