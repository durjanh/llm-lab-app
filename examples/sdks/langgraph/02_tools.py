"""Task 2, LangGraph: the tool loop written as a graph (graph_parts.agent_graph): model -> tools -> model until
the model stops asking for tools. recursion_limit caps the number of steps."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from graph_parts import agent_graph  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from shared import checks, engagements, tasks  # noqa: E402

graph = agent_graph(llm(), [tool(parse_docstring=True)(f) for f in engagements.READ_TOOLS], tasks.SYSTEM)
print(graph.get_graph().draw_mermaid())  # paste into any Mermaid viewer to see the loop
result = graph.invoke({"messages": [("user", tasks.QUESTION)]}, {"recursion_limit": 12})
for m in result["messages"]:
    for call in getattr(m, "tool_calls", []) or []:
        print(f"  tool call: {call['name']}({call['args']})")
answer = result["messages"][-1].content
print(answer)
checks.answer_ok("02_tools", answer)
