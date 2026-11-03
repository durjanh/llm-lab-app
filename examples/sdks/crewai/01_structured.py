"""Task 1: one call returning a typed object. In CrewAI: an Agent, a Task with output_pydantic, a one-task Crew."""
from crew_common import azure_llm  # sets up telemetry and the shared path first
from crewai import Agent, Crew, Task

from shared import checks, tasks

triager = Agent(role="Housing complaints triager", goal="Route each complaint correctly",
                backstory=tasks.SYSTEM, llm=azure_llm(), max_iter=3)
triage = Task(description=tasks.TRIAGE_PROMPT, expected_output="The complaint's category, urgency and a one-sentence summary",
              agent=triager, output_pydantic=tasks.Triage)
result = Crew(agents=[triager], tasks=[triage]).kickoff()

print(result.pydantic)
checks.triage_ok(result.pydantic)
