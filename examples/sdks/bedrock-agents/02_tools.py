"""Task 2 with Bedrock: Python functions as Converse tools; the script runs the tool loop (b.converse_loop)."""
import _bedrock as b

from shared import checks, engagements, tasks


def main() -> None:
    specs, run_tool = b.local_tools(engagements.READ_TOOLS)  # toolSpec JSON schemas from the type hints
    answer = b.converse_loop(b.Client("bedrock-runtime"), tasks.SYSTEM, tasks.QUESTION, specs, run_tool)
    print(answer)
    checks.answer_ok("02_tools", answer)


b.require_aws("02_tools")
b.run("02_tools", main)
