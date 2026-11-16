"""Redis as agent memory: long-term facts as hashes with vector fields (RedisVL), short-term chat in a list with a TTL.

Redis 8 in Docker on 127.0.0.1:18600. The container is started and removed (`down -v`) by this script.
"""
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/redis"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

import numpy as np  # noqa: E402
import redis  # noqa: E402
from redisvl.index import SearchIndex  # noqa: E402
from redisvl.query import FilterQuery, VectorQuery  # noqa: E402
from redisvl.query.filter import Tag  # noqa: E402

compose = ["docker", "compose", "-f", str(HERE / "docker-compose.yml")]
try:
    subprocess.run(compose + ["up", "-d", "--wait"], check=True, capture_output=True, text=True)
except (subprocess.CalledProcessError, FileNotFoundError) as e:
    checks.skip(NAME, f"needs Docker to run redis:8.0 ({str(getattr(e, 'stderr', e))[-150:].strip()})")
    sys.exit(0)

try:
    url = "redis://127.0.0.1:18600"
    r = redis.Redis.from_url(url)
    for _ in range(30):
        try:
            r.ping()
            break
        except redis.ConnectionError:
            time.sleep(1)
    info = r.info("server")

    index = SearchIndex.from_dict({
        "index": {"name": "memories", "prefix": "memory", "storage_type": "hash"},
        "fields": [
            {"name": "user_id", "type": "tag"},
            {"name": "active", "type": "tag"},
            {"name": "content", "type": "text"},
            {"name": "embedding", "type": "vector",
             "attrs": {"dims": shared.EMBED_DIM, "algorithm": "hnsw", "distance_metric": "cosine", "datatype": "float32"}},
        ]}, redis_url=url)
    index.create(overwrite=True)

    def vec(text: str) -> bytes:
        return np.array(shared.embed([text])[0], dtype=np.float32).tobytes()

    # Short-term memory: this session's messages in a list that expires on its own.
    history_key = f"chat:{shared.USER_ID}:{shared.SESSION_1}"
    for user_msg, reply in shared.SESSION_1_TURNS:
        r.rpush(history_key, json.dumps({"role": "user", "content": user_msg}), json.dumps({"role": "assistant", "content": reply}))
    r.expire(history_key, 3600)
    print(f"short-term list {history_key}: {r.llen(history_key)} messages, ttl {r.ttl(history_key)}s")

    # Long-term memory: facts as hashes. A correction switches the old hash's `active` tag off.
    for user_msg, _ in shared.SESSION_1_TURNS:
        rows = [(d["id"], d["content"]) for d in index.query(
            FilterQuery(
                filter_expression=(Tag("user_id") == shared.USER_ID) & (Tag("active") == "1"),
                return_fields=["content"], num_results=50))]
        out = shared.extract(user_msg, rows)
        for old in out["supersede"]:
            if old in {i for i, _ in rows}:
                r.hset(old, "active", "0")
        for fact in out["add"]:
            index.load([{"user_id": shared.USER_ID, "active": "1", "content": fact, "embedding": vec(fact)}],
                       keys=[f"memory:{uuid.uuid4().hex[:8]}"])
    total = index.info()["num_docs"]
    live = sum(1 for k in r.scan_iter("memory:*") if r.hget(k, "active") == b"1")
    print(f"{total} memory hashes, {live} active")

    # Session 2: a new conversation (no list), same user id.
    assert r.llen(f"chat:{shared.USER_ID}:{shared.SESSION_2}") == 0

    def recall(question: str) -> list[str]:
        q = VectorQuery(vector=vec(question), vector_field_name="embedding", return_fields=["content"], num_results=3,
                        filter_expression=(Tag("user_id") == shared.USER_ID) & (Tag("active") == "1"))
        return [d["content"] for d in index.query(q)]

    shared.evaluate(NAME, recall, f"redis {info['redis_version']}, {total} hashes ({live} active), chat list ttl set")
finally:
    subprocess.run(compose + ["down", "-v"], capture_output=True)
