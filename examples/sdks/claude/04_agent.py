"""Task 4 with the Claude API: an autonomous agent with harness features.

- the tool runner loops on its own until the goal is done, up to max_iterations (the step limit);
- iterating over the runner shows each turn, so every tool call is traced as it happens;
- the write tool is wrapped with an approval gate: a person says yes or no before log_risk runs.
"""
import argparse

from _claude import EFFORT, FALLBACKS, MODEL, as_tool, client, refused, text_of

from shared import checks, engagements, tasks

parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
args = parser.parse_args()


def gate(name: str, call_args: dict) -> bool:
    return name not in engagements.WRITE_TOOLS or checks.approve(name, call_args, args.auto_approve)


runner = client().beta.messages.tool_runner(
    model=MODEL, max_tokens=16000, system=tasks.SYSTEM, output_config=EFFORT, **FALLBACKS,
    tools=[as_tool(f, before=gate) for f in engagements.ALL_TOOLS],
    messages=[{"role": "user", "content": tasks.GOAL}],
    max_iterations=12,  # the step limit
)
step = 0
for message in runner:  # one Claude turn per iteration; the runner executes the tool calls in between
    step += 1
    calls = [b.name for b in message.content if b.type == "tool_use"]
    print(f"[step {step}] stop_reason={message.stop_reason} tools={calls}")
if not refused(message):
    print("\n" + text_of(message))
    checks.agent_ok()
