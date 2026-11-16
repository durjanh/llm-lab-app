"""Letta (formerly MemGPT): a stateful agent whose memory it edits itself. Core memory blocks sit in its prompt;
archival memory is a vector store it searches by tool call.

State of Letta (checked on the day this was written): the `letta/letta:latest` Docker image is now Letta Code, a
command line tool, and Letta says the Python REST server is end of life. The last server image is `letta/letta:0.16.8`
(port 8283 inside), which is what this uses, with Claude (claude-haiku-5-5) through ANTHROPIC_API_KEY passed to the
container from this process. The server has no local embedder and its hosted `letta/letta-free` embedding endpoint now answers 404, so archival
memory embeds with Azure OpenAI text-embedding-3-large, keyless: an Entra token from `az login` goes to the container
in place of an API key.

Session 1: each turn is a message to the agent, which edits its `human` block. The raw turns are also written to
archival memory. Session 2: the message history is reset (a new conversation, same agent and user), and the agent
answers from the memory it kept.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/letta"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

import httpx  # noqa: E402
from letta_client import Letta  # noqa: E402

compose = ["docker", "compose", "-f", str(HERE / "docker-compose.yml")]
if not config.AZURE_ENDPOINT:
    checks.skip(NAME, "set AZURE_OPENAI_ENDPOINT and run `az login` (Letta's own embedding endpoint is gone)")
    sys.exit(0)
try:
    from azure.identity import DefaultAzureCredential

    token = DefaultAzureCredential().get_token(config.AZURE_SCOPE).token
except Exception as e:  # noqa: BLE001
    checks.skip(NAME, f"run `az login` so Letta can embed with Azure OpenAI ({type(e).__name__})")
    sys.exit(0)
# Handed to the container, never written to a file.
env = {**os.environ, "ANTHROPIC_API_KEY": config.env("ANTHROPIC_API_KEY"), "LETTA_EMBED_TOKEN": token}
try:
    subprocess.run(compose + ["up", "-d"], check=True, capture_output=True, text=True, env=env)
except (subprocess.CalledProcessError, FileNotFoundError) as e:
    checks.skip(NAME, f"needs Docker to run letta/letta:0.16.8 ({str(getattr(e, 'stderr', e))[-150:].strip()})")
    sys.exit(0)

try:
    base = "http://127.0.0.1:18630"
    health = None
    for _ in range(60):
        try:
            health = httpx.get(f"{base}/v1/health/", timeout=3).json()
            break
        except httpx.HTTPError:
            time.sleep(2)
    if not health:
        checks.report(NAME, False, "the Letta server did not start")
        sys.exit(0)
    client = Letta(base_url=base)
    agent = client.agents.create(
        name="sam-assistant", model=f"anthropic/{config.CLAUDE_MODEL}", embedding_config={
            "embedding_endpoint_type": "openai", "embedding_endpoint": config.AZURE_V1_BASE_URL,
            "embedding_model": config.AZURE_EMBEDDING, "embedding_dim": 3072, "embedding_chunk_size": 300},
        memory_blocks=[
            {"label": "human", "value": "Nothing is known about the user yet."},
            {"label": "persona", "value": "You are Northwind's workplace assistant. Keep the human block up to date with "
                                          "every lasting fact the user tells you, and when they correct a fact, replace the "
                                          "old value. Record amounts, names and dates exactly. Before you say you do not know "
                                          "something about the user, search archival memory. Answer in one or two sentences."}])

    def say(text: str):
        reply = client.agents.messages.create(agent.id, messages=[{"role": "user", "content": text}])
        calls = [m.tool_call.name for m in reply.messages if m.message_type == "tool_call_message"]
        said = " ".join(m.content if isinstance(m.content, str) else "" for m in reply.messages
                        if m.message_type == "assistant_message")
        return said, calls

    for user_msg, _ in shared.SESSION_1_TURNS:
        _, calls = say(user_msg)
        print(f"  turn -> tools: {calls}")
        client.agents.passages.create(agent.id, text=f"Sam said: {user_msg}")  # archival memory, searched by similarity

    core = client.agents.blocks.retrieve("human", agent_id=agent.id).value
    archival = list(client.agents.passages.list(agent.id))
    print(f"core memory (human block):\n{core}\narchival memory: {len(archival)} passages")

    # Session 2: empty the message history. Core and archival memory stay.
    client.agents.messages.reset(agent.id)

    def respond(q: shared.Question) -> tuple[str, int]:
        rule = shared.handbook_section(q.section)
        said, calls = say((f"Handbook section:\n{rule}\n\n" if rule else "") + f"Question: {q.text}")
        return said, len(calls) + 1  # the core block counts as one recalled item

    ok = shared.evaluate(NAME, None, f"letta server {health.get('version')}, core block {len(core)} chars, "
                                     f"{len(archival)} archival passages", respond=respond)
    client.agents.delete(agent.id)
finally:
    subprocess.run(compose + ["down", "-v"], capture_output=True, env=env)
