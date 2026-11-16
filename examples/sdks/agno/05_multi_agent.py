"""Task 5 with Agno: a Team in coordinate mode. The leader delegates to the researcher, then to the writer.

Agno also has Workflows (steps in code) and route/broadcast/tasks team modes; coordinate fits a researcher
then a writer, with the leader passing the facts on.
"""
from _agno import model
from agno.agent import Agent
from agno.team import Team

from shared import checks, engagements, tasks

researcher = Agent(name="researcher", role="Gathers facts from the engagement tools", model=model(),
                   instructions=tasks.RESEARCHER + " Always report the client name.", tools=engagements.READ_TOOLS)
writer = Agent(name="writer", role="Writes the client update from the facts", model=model(), instructions=tasks.WRITER)
team = Team(name="update desk", members=[researcher, writer], model=model(),
            instructions="First ask the researcher for the facts, including the client's name, then ask the writer to draft "
                         "the update from them. Reply with the writer's bullets only.")

update = team.run(tasks.UPDATE_BRIEF).content
print(update)
checks.update_ok(update)
