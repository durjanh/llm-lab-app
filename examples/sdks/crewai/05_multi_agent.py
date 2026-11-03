"""Task 5: CrewAI's own multi-agent pattern: a crew of two agents run in sequence. The researcher's task output
becomes context for the writer's task."""
from crew_common import as_tool, azure_llm
from crewai import Agent, Crew, Process, Task

from shared import checks, engagements, tasks

llm = azure_llm()
researcher = Agent(role="Researcher", goal="Gather the facts for a client update", backstory=tasks.RESEARCHER,
                   llm=llm, tools=[as_tool(f) for f in engagements.READ_TOOLS], max_iter=8)
writer = Agent(role="Writer", goal="Write clear client updates", backstory=tasks.WRITER, llm=llm, max_iter=3)

research = Task(description=f"Gather the facts needed for this: {tasks.UPDATE_BRIEF}",
                expected_output="The engagement's progress, budget and spend, and open risks with owners", agent=researcher)
write = Task(description=tasks.UPDATE_BRIEF, expected_output="Exactly three bullets", agent=writer, context=[research])

result = Crew(agents=[researcher, writer], tasks=[research, write], process=Process.sequential).kickoff()

print(result.raw)
checks.update_ok(result.raw)
