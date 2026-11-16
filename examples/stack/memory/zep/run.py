"""Zep's open-source core, Graphiti: a temporal knowledge graph on Neo4j, with Claude reading the conversation.

State of Zep (checked on the day this was written): Zep Community Edition was deprecated in April 2025 (the repository
is frozen under Apache 2.0, no updates). Graphiti, the engine inside Zep's cloud product, is the part that stays open
source and maintained. This script runs Graphiti on Neo4j in Docker, with Claude as its LLM and local BGE embeddings.
Each session 1 turn is an episode with its own time. When the corrected cost arrives, Graphiti sets `invalid_at` on the
£600 fact instead of deleting it, and recall keeps only facts that are still valid.

It also holds the Zep Cloud code path (`run_cloud`). That needs ZEP_API_KEY and is skipped without one.
"""
import asyncio
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

import logging  # noqa: E402

for noisy in ("neo4j", "graphiti_core"):  # index-exists and empty-graph warnings from a fresh database
    logging.getLogger(noisy).setLevel(logging.CRITICAL)

NAME = "memory/zep"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.cross_encoder.client import CrossEncoderClient  # noqa: E402
from graphiti_core.embedder.client import EmbedderClient  # noqa: E402
from graphiti_core.llm_client.anthropic_client import AnthropicClient  # noqa: E402
from graphiti_core.llm_client.config import LLMConfig  # noqa: E402
from graphiti_core.nodes import EpisodeType  # noqa: E402
from graphiti_core.search.search_config_recipes import COMBINED_HYBRID_SEARCH_RRF  # noqa: E402


class LocalEmbedder(EmbedderClient):
    """Graphiti's embedder hook, backed by the shared local BGE model (no OpenAI key)."""

    async def create(self, input_data):
        texts = [input_data] if isinstance(input_data, str) else list(input_data)
        return shared.embed([t if isinstance(t, str) else str(t) for t in texts])[0]

    async def create_batch(self, input_data_list):
        return shared.embed(list(input_data_list))


class KeepOrder(CrossEncoderClient):
    """Graphiti wants a reranker; its default needs OpenAI. This one keeps the order the graph search already gave."""

    async def rank(self, query, passages):
        return [(p, 1.0 / (i + 1)) for i, p in enumerate(passages)]


class HaikuClient(AnthropicClient):
    """claude-haiku-5-5 rejects `temperature`, which Graphiti always sends, so leave it out."""

    async def _generate_response(self, *args, **kwargs):
        original = self.client.messages.create

        async def create(**kwargs):
            kwargs.pop("temperature", None)
            return await original(**kwargs)

        self.client.messages.create = create
        try:
            return await super()._generate_response(*args, **kwargs)
        finally:
            self.client.messages.create = original


def run_cloud(api_key: str) -> bool:
    """The Zep Cloud path: Zep builds the same temporal graph for you. Not run without ZEP_API_KEY."""
    from zep_cloud import AddMessage
    from zep_cloud.client import Zep

    zep = Zep(api_key=api_key)
    user = zep.user.create(user_id=f"{shared.USER_ID}-stack", first_name="Sam")
    thread = zep.thread.create(user_uuid=user.uuid_)
    for user_msg, reply in shared.SESSION_1_TURNS:
        zep.thread.add_messages(thread.uuid_, messages=[AddMessage(role="user", name="Sam", content=user_msg),
                                                        AddMessage(role="assistant", content=reply)])
    time.sleep(30)  # Zep ingests asynchronously

    def recall(question: str) -> list[str]:
        edges = zep.graph.search_edges(user.uuid_, query=question, page_size=5)
        return [e.fact for e in edges if e.fact and not e.invalid_at]

    return shared.evaluate("memory/zep", recall, "Zep Cloud")


def build_cloud_request() -> str:
    """Check the Cloud code path imports and builds its objects without calling the network."""
    from zep_cloud import AddMessage
    from zep_cloud.client import Zep

    Zep(api_key="not-a-real-key")
    AddMessage(role="user", name="Sam", content=shared.SESSION_1_TURNS[0][0])
    return "Zep Cloud path builds (set ZEP_API_KEY to run it)"


async def main() -> bool:
    compose = ["docker", "compose", "-f", str(HERE / "docker-compose.yml")]
    try:
        subprocess.run(compose + ["up", "-d", "--wait", "--wait-timeout", "180"], check=True, capture_output=True, text=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        checks.skip(NAME, f"needs Docker to run neo4j:5.26-community ({str(getattr(e, 'stderr', e))[-150:].strip()})")
        return True
    graphiti = None
    try:
        llm = HaikuClient(LLMConfig(model=config.CLAUDE_MODEL, small_model=config.CLAUDE_MODEL, max_tokens=8000))
        graphiti = Graphiti("bolt://127.0.0.1:18620", "neo4j", "labpassword", llm_client=llm, embedder=LocalEmbedder(),
                            cross_encoder=KeepOrder())
        await graphiti.build_indices_and_constraints()

        # Session 1: six turns, an hour apart, so the correction is later than the first cost.
        start = datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
        for i, (user_msg, reply) in enumerate(shared.SESSION_1_TURNS):
            await graphiti.add_episode(name=f"turn-{i + 1}", episode_body=f"Sam: {user_msg}",
                                       source=EpisodeType.message, source_description="chat with Sam",
                                       reference_time=start + timedelta(hours=i), group_id=shared.USER_ID)
        records, _, _ = await graphiti.driver.execute_query(
            "MATCH ()-[e:RELATES_TO]->() RETURN e.fact AS fact, e.valid_at AS v, e.invalid_at AS i ORDER BY e.created_at")
        print(f"{len(records)} facts in the graph:")
        for r in records:
            print(f"  {'(invalid since ' + str(r['i'])[:16] + ') ' if r['i'] else ''}{r['fact']}")
        ended = sum(1 for r in records if r["i"])
        nodes, _, _ = await graphiti.driver.execute_query("MATCH (n:Entity) RETURN n.name AS name, n.summary AS summary")
        print(f"{len(nodes)} entities:")
        for n in nodes:
            print(f"  {n['name']}: {n['summary']}")

        # Session 2: search the graph by user id only; facts that are no longer valid are dropped.
        recalled: dict[str, list[str]] = {}
        for q in shared.QUESTIONS:
            found = await graphiti.search_(q.text, config=COMBINED_HYBRID_SEARCH_RRF, group_ids=[shared.USER_ID])
            recalled[q.text] = ([f"{e.fact} (valid from {str(e.valid_at)[:10]})" for e in found.edges[:6]
                                 if not e.invalid_at and e.fact != "placeholder"]
                                + [f"{n.name}: {n.summary}" for n in found.nodes[:3] if n.summary])
        note = build_cloud_request()
        import os

        if os.environ.get("ZEP_API_KEY"):
            note = "Zep Cloud: " + ("PASS" if run_cloud(os.environ["ZEP_API_KEY"]) else "FAIL")
        return shared.evaluate(NAME, lambda q: recalled[q], f"graphiti-core, {len(records)} facts, {ended} invalidated by "
                                                           f"the correction; {note}")
    finally:
        if graphiti:
            await graphiti.close()
        subprocess.run(compose + ["down", "-v"], capture_output=True)


asyncio.run(main())
