"""Task 2, LangChain: function tools. `@tool` turns a Python function into a tool (schema from the type hints and
docstring); `create_agent` runs the model-and-tools loop until the model answers."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from langchain.agents import create_agent  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from shared import checks, engagements, tasks  # noqa: E402

tools = [tool(parse_docstring=True)(f) for f in engagements.READ_TOOLS]
agent = create_agent(llm(), tools, system_prompt=tasks.SYSTEM)
result = agent.invoke({"messages": [{"role": "user", "content": tasks.QUESTION}]})
for m in result["messages"]:
    for call in getattr(m, "tool_calls", []) or []:
        print(f"  tool call: {call['name']}({call['args']})")
answer = result["messages"][-1].content
print(answer)
checks.answer_ok("02_tools", answer)
