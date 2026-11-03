"""Task 4, LangChain: an autonomous agent with harness features added as middleware.

- HumanInTheLoopMiddleware pauses before log_risk (a LangGraph interrupt, so it needs a checkpointer);
  we answer with Command(resume={"decisions": [...]}) after asking a person.
- ModelCallLimitMiddleware is the step limit.
- A wrap_tool_call middleware prints a trace line for every tool that runs.

    python 04_agent.py [--auto-approve]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import HumanInTheLoopMiddleware, ModelCallLimitMiddleware, wrap_tool_call  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.types import Command  # noqa: E402
from shared import checks, engagements, tasks  # noqa: E402


@wrap_tool_call
def trace(request, handler):
    print(f"  tool: {request.tool_call['name']}({request.tool_call['args']})")
    return handler(request)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auto-approve", action="store_true")
    args = parser.parse_args()

    agent = create_agent(
        llm(), [tool(parse_docstring=True)(f) for f in engagements.ALL_TOOLS], system_prompt=tasks.SYSTEM,
        middleware=[HumanInTheLoopMiddleware(interrupt_on={w: {"allowed_decisions": ["approve", "reject"]}
                                                           for w in engagements.WRITE_TOOLS}),
                    ModelCallLimitMiddleware(run_limit=12, exit_behavior="end"),
                    trace],
        checkpointer=InMemorySaver(),
    )
    run = {"configurable": {"thread_id": "task-4"}}
    result = agent.invoke({"messages": [{"role": "user", "content": tasks.GOAL}]}, run, version="v2")
    while result.interrupts:  # paused: one HITLRequest listing the gated calls of this model turn
        decisions = []
        for request in result.interrupts[0].value["action_requests"]:
            ok = checks.approve(request["name"], request["args"], args.auto_approve)
            decisions.append({"type": "approve"} if ok else {"type": "reject", "message": "A person declined this."})
        result = agent.invoke(Command(resume={"decisions": decisions}), run, version="v2")

    print("\n" + result.value["messages"][-1].content)
    checks.agent_ok()


main()
