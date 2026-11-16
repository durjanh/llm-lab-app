"""Task 5 with Bedrock: a researcher, then a writer, each its own Converse call with its own system prompt and tools.

Bedrock's own pattern is multi-agent collaboration (a supervisor agent with collaborator agents), but every
collaborator needs a deployed agent, alias and Lambda action groups for its tools, so this task chains two
Converse agents in code instead.
"""
import _bedrock as b

from shared import checks, engagements, tasks


def main() -> None:
    bedrock = b.Client("bedrock-runtime")
    specs, run_tool = b.local_tools(engagements.READ_TOOLS)
    facts = b.converse_loop(bedrock, tasks.RESEARCHER + " Always report the client name.", tasks.UPDATE_BRIEF, specs, run_tool)
    print("researcher ->", facts, "\n")
    update = b.converse_loop(bedrock, tasks.WRITER, f"Brief: {tasks.UPDATE_BRIEF}\n\nResearcher's facts:\n{facts}", [], None)
    print(update)
    checks.update_ok(update)


b.require_aws("05_multi_agent")
b.run("05_multi_agent", main)
