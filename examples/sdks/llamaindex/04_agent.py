"""Task 4 with LlamaIndex: a FunctionAgent (itself a Workflow) with harness features.

- run(max_iterations=...) is the step limit;
- the event stream carries a ToolCall event for every call, which is the trace;
- log_risk's wrapper waits for a person with ctx.wait_for_event(HumanResponseEvent) after emitting an
  InputRequiredEvent; the script answers it on the stream with ctx.send_event (the run waits, then resumes).

    python 04_agent.py [--auto-approve]
"""
import argparse
import asyncio

from _li import llm
from llama_index.core.agent.workflow import FunctionAgent, ToolCall
from llama_index.core.tools import FunctionTool
from llama_index.core.workflow import Context, HumanResponseEvent, InputRequiredEvent

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()


async def log_risk(ctx: Context, engagement_id: str, title: str, severity: str, owner: str) -> dict:
    ctx.write_event_to_stream(InputRequiredEvent(prefix="log_risk", engagement_id=engagement_id, title=title,
                                                 severity=severity, owner=owner))
    answer = await ctx.wait_for_event(HumanResponseEvent, waiter_id=f"{engagement_id}:{title}")  # pauses this call
    if answer.response != "yes":
        return {"error": "A person declined this call. Do not retry it; say it was not done."}
    return engagements.log_risk(engagement_id, title, severity, owner)  # type: ignore[arg-type]


gated = FunctionTool.from_defaults(async_fn=log_risk, name="log_risk", description=engagements.log_risk.__doc__)
agent = FunctionAgent(tools=[*engagements.READ_TOOLS, gated], llm=llm(),
                      system_prompt=tasks.SYSTEM + " Approval for writes is handled by the system: call log_risk directly, do not ask the user.")


async def main() -> None:
    handler = agent.run(tasks.GOAL, max_iterations=20)
    seen = set()  # a step that waited re-runs from its start when the answer arrives, so its events come twice
    async for event in handler.stream_events():
        if isinstance(event, ToolCall) and event.tool_id not in seen:
            seen.add(event.tool_id)
            print(f"  tool: {event.tool_name}({event.tool_kwargs})")
        elif isinstance(event, InputRequiredEvent) and (event.engagement_id, event.title) not in seen:
            seen.add((event.engagement_id, event.title))
            ok = checks.approve(event.prefix, {k: v for k, v in event.items() if k != "prefix"}, args.auto_approve)
            handler.ctx.send_event(HumanResponseEvent(response="yes" if ok else "no", waiter_id=f"{event.engagement_id}:{event.title}"))
    print("\n" + str(await handler))
    checks.agent_ok()


asyncio.run(main())
