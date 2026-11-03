"""Task 2 with the Claude API: Python functions as tools; the SDK's tool runner (beta) runs the loop."""
from _claude import EFFORT, FALLBACKS, MODEL, as_tool, client, refused, text_of

from shared import checks, engagements, tasks

runner = client().beta.messages.tool_runner(
    model=MODEL, max_tokens=16000, system=tasks.SYSTEM, output_config=EFFORT, **FALLBACKS,
    tools=[as_tool(f) for f in engagements.READ_TOOLS],
    messages=[{"role": "user", "content": tasks.QUESTION}],
    max_iterations=8,
)
final = runner.until_done()  # calls Claude, runs each tool it asks for, sends the results back, until it stops
if not refused(final):
    answer = text_of(final)
    print(answer)
    checks.answer_ok("02_tools", answer)
