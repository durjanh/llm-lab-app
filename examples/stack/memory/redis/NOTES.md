# Redis as agent memory

**What it is.** Redis 8.0 in Docker (`redis:8.0`, port 18600), which has the query engine (vector search) built in, so no separate redis-stack image is needed. RedisVL 0.32 is the Python layer.

**What kind of memory.** Two kinds, in one server. Short-term: the session's messages in a Redis list (`chat:sam:session-1`) with a one-hour TTL, so it expires by itself. Long-term: facts as hashes with a vector field, searched by RedisVL's `VectorQuery` with a tag filter (`user_id`, `active`).

**How it does the task.** Claude extracts facts as in `chroma/`. A correction sets the old hash's `active` tag to `0`. Session 2 starts with an empty list and searches the long-term index. Memory use stayed small: the container was limited to 256 MB and the index held about seven small hashes.

**Limits.** Redis is fast and has the TTL built in, but the "which fact replaces which" rule is ours. The list is only the chat log; nothing summarises it.

Ran on 2026-11-15: PASS memory/redis: 5/5 answers correct, corrected fact £450 won; redis 8.0.6, 7 hashes (6 active), chat list ttl set
