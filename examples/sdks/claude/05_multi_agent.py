"""Task 5 with the Claude API: two agents in sequence (orchestrator and worker, by hand).

The Claude API has no multi-agent object of its own: a researcher agent (tool runner with the read tools)
gathers the facts, then a writer call turns them into the update. For hosted multi-agent work, Anthropic's
Managed Agents and the Claude Agent SDK (subagents) are separate products; see NOTES.md.
"""
from _claude import EFFORT, FALLBACKS, MODEL, as_tool, client, refused, text_of

from shared import checks, engagements, tasks

claude = client()
research = claude.beta.messages.tool_runner(
    model=MODEL, max_tokens=16000, system=tasks.RESEARCHER, output_config=EFFORT, **FALLBACKS,
    tools=[as_tool(f) for f in engagements.READ_TOOLS],
    messages=[{"role": "user", "content": tasks.UPDATE_BRIEF}], max_iterations=6,
).until_done()
if not refused(research):
    facts = text_of(research)
    print("Researcher:\n" + facts)
    update = claude.beta.messages.create(
        model=MODEL, max_tokens=16000, system=tasks.WRITER, output_config=EFFORT, **FALLBACKS,
        messages=[{"role": "user", "content": f"{tasks.UPDATE_BRIEF}\n\nThe researcher's facts:\n{facts}"}],
    )
    if not refused(update):
        print("\nWriter:\n" + text_of(update))
        checks.update_ok(text_of(update))
