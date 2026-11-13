"""Task 4 with PydanticAI: an autonomous agent with harness features.

- UsageLimits(tool_calls_limit=...) is the step limit;
- event_stream_handler sees every tool call as it starts, which is the trace;
- the write tool is registered with requires_approval=True: the run ends with DeferredToolRequests, a person
  answers, and a second run continues from the saved messages with DeferredToolResults (pause and resume).

    python 04_agent.py [--auto-approve]
"""
import argparse

from _pai import model
from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults, FunctionToolCallEvent, Tool, UsageLimits

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()


async def trace(ctx, events) -> None:
    async for event in events:
        if isinstance(event, FunctionToolCallEvent):
            print(f"  tool: {event.part.tool_name}({event.part.args})")


tools = [Tool(f, requires_approval=f.__name__ in engagements.WRITE_TOOLS) for f in engagements.ALL_TOOLS]
agent = Agent(model(), instructions=tasks.SYSTEM + " Approval for writes is handled by the system: call log_risk directly, do not ask the user.",
              tools=tools, output_type=[str, DeferredToolRequests])
limits = UsageLimits(tool_calls_limit=20)

result = agent.run_sync(tasks.GOAL, usage_limits=limits, event_stream_handler=trace)
while isinstance(result.output, DeferredToolRequests):
    answers = DeferredToolResults()
    for call in result.output.approvals:  # the calls waiting for a person
        answers.approvals[call.tool_call_id] = checks.approve(call.tool_name, call.args_as_dict(), args.auto_approve)
    result = agent.run_sync(message_history=result.all_messages(), deferred_tool_results=answers,
                            usage_limits=limits, event_stream_handler=trace)
print("\n" + result.output)
checks.agent_ok()
