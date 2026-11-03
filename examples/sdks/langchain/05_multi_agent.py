"""Task 5, LangChain: subagents as tools. A researcher agent (with the engagement tools) and a writer agent are
each wrapped as a tool of a supervisor agent, which decides when to call them."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from langchain.agents import create_agent  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from shared import checks, engagements, tasks  # noqa: E402

model = llm()
researcher = create_agent(model, [tool(parse_docstring=True)(f) for f in engagements.READ_TOOLS],
                          system_prompt=tasks.RESEARCHER, name="researcher")
writer = create_agent(model, [], system_prompt=tasks.WRITER, name="writer")


@tool
def ask_researcher(request: str) -> str:
    """Ask the researcher to look up facts about engagements. Returns the facts found."""
    print(f"  -> researcher: {request}")
    return researcher.invoke({"messages": [{"role": "user", "content": request}]})["messages"][-1].content


@tool
def ask_writer(facts: str) -> str:
    """Give the writer the facts; returns the three-bullet client update."""
    print("  -> writer")
    return writer.invoke({"messages": [{"role": "user", "content": f"{tasks.UPDATE_BRIEF}\n\nFacts:\n{facts}"}]})["messages"][-1].content


supervisor = create_agent(model, [ask_researcher, ask_writer], system_prompt=(
    "You coordinate a researcher and a writer. Get the facts from the researcher, including the client's name, "
    "pass every fact to the writer, and reply with the writer's update exactly."))
update = supervisor.invoke({"messages": [{"role": "user", "content": tasks.UPDATE_BRIEF}]})["messages"][-1].content
print(update)
checks.update_ok(update)
