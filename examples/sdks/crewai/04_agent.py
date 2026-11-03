"""Task 4: an autonomous agent with harness controls.
- step limit: the agent's max_iter (and max_execution_time as a wall-clock stop)
- trace: a before_tool_call hook prints every tool call
- human approval: a before_tool_call hook on log_risk asks a person; returning False blocks the call
"""
import argparse

from crew_common import as_tool, azure_llm
from crewai import Agent, Crew, Task
from crewai.hooks import before_tool_call

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
AUTO = parser.parse_args().auto_approve


@before_tool_call
def trace(context):
    print(f"  tool call: {context.tool_name}({context.tool_input})")
    return None  # None: carry on


@before_tool_call(tools=list(engagements.WRITE_TOOLS))
def require_approval(context):
    return None if checks.approve(context.tool_name, dict(context.tool_input), AUTO) else False  # False: blocked


tools = [as_tool(f) for f in engagements.ALL_TOOLS]
reviewer = Agent(role="Engagement risk reviewer", goal="Keep the risk register right", backstory=tasks.SYSTEM,
                 llm=azure_llm(), tools=tools, max_iter=12, max_execution_time=300)
review = Task(description=tasks.GOAL, expected_output="What was logged, on which engagement, and why", agent=reviewer)
result = Crew(agents=[reviewer], tasks=[review]).kickoff()

print(result.raw)
checks.agent_ok()
