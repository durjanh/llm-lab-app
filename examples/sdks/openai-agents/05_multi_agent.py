"""Task 5 with the OpenAI Agents SDK: a handoff. The researcher gathers facts with the tools, then hands
the conversation to the writer, which drafts the update. The SDK's other pattern is agents-as-tools
(agent.as_tool), where a manager calls specialists and keeps control."""
from _common import Trace, get_engagement, model, search_engagements
from agents import Agent, Runner
from shared import checks, tasks

m = model()
writer = Agent(name="writer", instructions=tasks.WRITER, model=m)
researcher = Agent(name="researcher", model=m, tools=[search_engagements, get_engagement], handoffs=[writer],
                   instructions=tasks.RESEARCHER + " When you have the facts, hand off to the writer with them.")
result = Runner.run_sync(researcher, tasks.UPDATE_BRIEF, hooks=Trace(), max_turns=12)
print(f"Last agent: {result.last_agent.name}\n{result.final_output}")
checks.update_ok(result.final_output)
