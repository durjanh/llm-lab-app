"""Task 5 with Strands Agents: its Graph pattern, a researcher node then a writer node.

Strands also has Swarm (agents hand off to each other) and "agents as tools" (an orchestrator calls
specialists like functions); a Graph fits a fixed order, which is what this task is.
"""
from _strands import as_tools, model
from strands import Agent
from strands.multiagent import GraphBuilder

from shared import checks, engagements, tasks

researcher = Agent(model=model(), name="researcher", system_prompt=tasks.RESEARCHER + " Always report the client name.",
                   tools=as_tools(engagements.READ_TOOLS), callback_handler=None)
writer = Agent(model=model(), name="writer", system_prompt=tasks.WRITER, callback_handler=None)

builder = GraphBuilder()
builder.add_node(researcher, "researcher")
builder.add_node(writer, "writer")
builder.add_edge("researcher", "writer")  # the writer receives the researcher's output
builder.set_entry_point("researcher")
builder.set_max_node_executions(2)  # the step limit: each node runs once
graph = builder.build()

result = graph(tasks.UPDATE_BRIEF)
update = str(result.results["writer"].result)
print(update)
checks.update_ok(update)
