"""Task 4 with Google ADK: an autonomous agent with harness features.

- RunConfig(max_llm_calls=...) is the step limit;
- the events from the runner carry every function call, which is the trace;
- log_risk is a FunctionTool(require_confirmation=True): the run stops with an `adk_request_confirmation` call, a
  person answers, and a second run_async on the same session sends back a FunctionResponse (pause and resume).

    python 04_agent.py [--auto-approve]
"""
import argparse
import asyncio

from _adk import final_text, message, model
from google.adk.agents import LlmAgent, RunConfig
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool
from google.genai import types

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()

tools = [FunctionTool(f, require_confirmation=f.__name__ in engagements.WRITE_TOOLS) for f in engagements.ALL_TOOLS]
agent = LlmAgent(name="reviewer", model=model(), tools=tools,
                 instruction=tasks.SYSTEM + " Approval for writes is handled by the system: call log_risk directly, do not ask the user.")
runner = InMemoryRunner(agent=agent, app_name="sdks")


async def main() -> None:
    session = await runner.session_service.create_session(app_name="sdks", user_id="u")
    content, report = message(tasks.GOAL), ""
    while content:
        answers = []  # confirmation requests this run stopped on
        async for event in runner.run_async(user_id="u", session_id=session.id, new_message=content,
                                            run_config=RunConfig(max_llm_calls=20)):
            for call in event.get_function_calls():
                if call.name == "adk_request_confirmation":
                    original = call.args["originalFunctionCall"]
                    ok = checks.approve(original["name"], original["args"], args.auto_approve)
                    answers.append(types.Part(function_response=types.FunctionResponse(
                        id=call.id, name=call.name, response={"confirmed": ok})))
                else:
                    print(f"  tool: {call.name}({call.args})")
            report = final_text(event) or report
        content = types.Content(role="user", parts=answers) if answers else None
    print("\n" + report)
    checks.agent_ok()


asyncio.run(main())
