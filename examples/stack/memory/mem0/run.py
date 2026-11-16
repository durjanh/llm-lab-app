"""Mem0 open source: a managed memory layer. Claude extracts and updates memories, BGE embeds them, Qdrant stores them.

Session 1 turns go in through `Memory.add`; Mem0 decides what to add, update or delete (this is where £600 becomes
£450). Session 2 searches by user id only, so no chat history carries over.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/mem0"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

os.environ["MEM0_TELEMETRY"] = "False"
from importlib.metadata import version  # noqa: E402

from mem0 import Memory  # noqa: E402

with tempfile.TemporaryDirectory(prefix="stack-mem0-") as folder:
    memory = Memory.from_config({
        "llm": {"provider": "anthropic", "config": {"model": config.CLAUDE_MODEL, "max_tokens": 4000,
                                                    # Mem0 sends temperature for any haiku; haiku-5-5 rejects it.
                                                    "enable_sampling_parameters": False}},
        "embedder": {"provider": "fastembed", "config": {"model": config.LOCAL_EMBEDDING, "embedding_dims": shared.EMBED_DIM}},
        "vector_store": {"provider": "qdrant", "config": {"collection_name": "memories", "path": f"{folder}/qdrant",
                                                          "embedding_model_dims": shared.EMBED_DIM}},
        "history_db_path": f"{folder}/history.db",
    })

    # Session 1: each turn is added as a user/assistant pair; Mem0 extracts and reconciles.
    for user_msg, reply in shared.SESSION_1_TURNS:
        out = memory.add([{"role": "user", "content": user_msg}, {"role": "assistant", "content": reply}],
                         user_id=shared.USER_ID)
        print("  add ->", [(r.get("event"), r.get("memory")) for r in out.get("results", [])])

    def listing():
        found = memory.get_all(filters={"user_id": shared.USER_ID})
        return found["results"] if isinstance(found, dict) else found

    stored = listing()
    print(f"{len(stored)} memories after session 1:")
    for m in stored:
        print("  ", m["memory"])

    def recall(question: str) -> list[str]:
        found = memory.search(question, filters={"user_id": shared.USER_ID}, top_k=4)
        found = found["results"] if isinstance(found, dict) else found
        return [m["memory"] for m in found]

    ok = shared.evaluate(NAME, recall, f"mem0ai {version('mem0ai')}, {len(stored)} memories")
    memory.vector_store.client.close()  # local Qdrant: close before the temp folder goes
