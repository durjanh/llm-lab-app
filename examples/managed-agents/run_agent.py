"""A minimal Claude Managed Agent: Anthropic runs the agent loop and the sandbox, we send a task and read events.

Flow: environment (once) -> agent (once) -> session (every run) -> send a message -> stream events until idle.
The SDK sets the beta header `managed-agents-2026-04-01` for every `client.beta.{environments,agents,sessions}` call.
Needs ANTHROPIC_API_KEY (or an `ant auth login` profile). Sessions are billed (tokens plus session time).

    python run_agent.py
    MANAGED_AGENT_ID=agent_... MANAGED_ENV_ID=env_... python run_agent.py   # reuse what an earlier run created
"""
import os

import anthropic

MODEL = "claude-haiku-5-5"
TASK = ("Write a Python script that prints the first 15 Fibonacci numbers, run it, and save the script as "
        "/mnt/session/outputs/fib.py. Then tell me the numbers it printed.")

client = anthropic.Anthropic()

# 1. The environment: the container template the agent's tools run in. Limited networking = deny by default.
env_id = os.environ.get("MANAGED_ENV_ID") or client.beta.environments.create(
    name="llm-lab-env",
    config={"type": "cloud", "networking": {"type": "limited"}},
).id

# 2. The agent: a stored, versioned config (model, system prompt, tools). Create it once and keep its id; in a real
# project this belongs in setup (for example `ant apply`), not in the request path.
if os.environ.get("MANAGED_AGENT_ID"):
    agent = client.beta.agents.retrieve(os.environ["MANAGED_AGENT_ID"])
else:
    agent = client.beta.agents.create(
        name="LLM Lab coding helper",
        model=MODEL,
        system="You write and run small Python scripts in your sandbox and report what they printed.",
        tools=[{
            "type": "agent_toolset_20260401",  # Anthropic's built-in bash, file and code tools, run in the sandbox
            "default_config": {"enabled": True, "permission_policy": {"type": "auto"}},
            "configs": [{"name": "web_fetch", "enabled": False}, {"name": "web_search", "enabled": False}],
        }],
    )
print(f"agent {agent.id} (version {agent.version}), environment {env_id}")

# 3. The session: one run of the agent, pinned to that agent version, with its own container.
session = client.beta.sessions.create(agent={"type": "agent", "id": agent.id, "version": agent.version},
                                      environment_id=env_id, title="Fibonacci demo")
print(f"session {session.id}")

# 4. Open the event stream first, then send the task, so no early events are missed.
with client.beta.sessions.events.stream(session_id=session.id) as stream:
    client.beta.sessions.events.send(
        session_id=session.id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": TASK}]}],
    )
    for event in stream:
        if event.type == "agent.message":  # the agent's words
            for block in event.content:
                if block.type == "text":
                    print(block.text, end="", flush=True)
        elif event.type in ("agent.tool_use", "agent.mcp_tool_use"):
            if getattr(event, "evaluated_permission", None) == "ask":  # paused for a decision; nobody is watching, so deny
                client.beta.sessions.events.send(
                    session_id=session.id,
                    events=[{"type": "user.tool_confirmation", "tool_use_id": event.id, "result": "deny"}],
                )
            else:
                print(f"\n  [tool] {event.name}")
        elif event.type == "session.status_idle":
            if event.stop_reason.type != "requires_action":  # requires_action means it waits on us: keep streaming
                break
        elif event.type == "session.status_terminated":
            break

# 5. Result: usage, and the files the agent wrote to /mnt/session/outputs (indexing can lag a second or two).
session = client.beta.sessions.retrieve(session_id=session.id)
print(f"\n\nstatus: {session.status}, usage: {session.usage}")
for f in client.beta.files.list(scope_id=session.id, betas=["managed-agents-2026-04-01"]).data:
    print(f"output file: {f.filename} ({f.size_bytes} bytes)")
    client.beta.files.download(f.id).write_to_file(f.filename)
print(f"Trace: https://platform.claude.com/workspaces/default/sessions/{session.id}")
