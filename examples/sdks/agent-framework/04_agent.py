"""Task 4 with Agent Framework: an autonomous agent with harness features.

- log_risk is a tool with approval_mode="always_require": instead of running it, the agent stops and
  returns a function_approval_request; a person approves or rejects, and the run resumes in the same session;
- max_iterations on the chat client is the step limit;
- function middleware traces every tool call.
"""
import argparse
import asyncio

from _af import chat_client, trace
from agent_framework import Agent, Message, tool

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()


async def main() -> None:
    tools = [tool(engagements.search_engagements), tool(engagements.get_engagement),
             tool(engagements.log_risk, approval_mode="always_require")]
    agent = Agent(chat_client(max_iterations=12), tasks.SYSTEM, name="reviewer", tools=tools, middleware=[trace])
    session = agent.create_session()
    response = await agent.run(tasks.GOAL, session=session)
    rounds = 0
    while response.user_input_requests and rounds < 5:  # the agent is waiting for a person
        rounds += 1
        answers = []
        for request in response.user_input_requests:
            call = request.function_call
            call_args = call.parse_arguments() if hasattr(call, "parse_arguments") else call.arguments
            answers.append(request.to_function_approval_response(checks.approve(call.name, call_args, args.auto_approve)))
        response = await agent.run(Message("user", answers), session=session)
    print("\n" + response.text)
    checks.agent_ok()


asyncio.run(main())
