"""Task 5 with CAMEL: a Workforce in pipeline mode, a research task then a writing task.

CAMEL also has RolePlaying (two agents talk to finish a task) and Workforce's automatic decomposition;
a pipeline fits a fixed order. The coordinator picks which worker takes each task.
"""
from _camel import as_tools, model
from camel.agents import ChatAgent
from camel.societies.workforce import Workforce, WorkforceMode
from camel.tasks import Task

from shared import checks, engagements, tasks

researcher = ChatAgent(system_message=tasks.RESEARCHER + " Always report the client name.", model=model(),
                       tools=as_tools(engagements.READ_TOOLS))
writer = ChatAgent(system_message=tasks.WRITER, model=model())

workforce = Workforce("update desk", coordinator_agent=ChatAgent(model=model()), task_agent=ChatAgent(model=model()),
                      new_worker_agent=ChatAgent(model=model()), mode=WorkforceMode.PIPELINE)
workforce.add_single_agent_worker("researcher: gathers facts from the engagement tools", worker=researcher)
workforce.add_single_agent_worker("writer: turns facts into the client update", worker=writer)
workforce.pipeline_add("Use the engagement tools to gather the facts for this brief, and report them plainly: " + tasks.UPDATE_BRIEF, task_id="research")
workforce.pipeline_add("Write the update from the research result. Brief: " + tasks.UPDATE_BRIEF, task_id="write")
workforce.pipeline_build()

done = workforce.process_task(Task(content=tasks.UPDATE_BRIEF, id="update"))
update = done.subtasks[-1].result if done.subtasks else done.result  # the writing task is the last in the pipeline
print(update)
checks.update_ok(update)
