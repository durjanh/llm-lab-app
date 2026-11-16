# Zep, through Graphiti

**State of Zep (checked 2026-11-15).** Zep Community Edition was deprecated in April 2025: Zep stopped maintaining it and the repository stays under Apache 2.0 with no updates. Graphiti, the temporal knowledge graph engine inside Zep's cloud product, is the part that stays open source. So the self-hosted way to run "Zep" now is Graphiti on its own graph database. (Source: Zep's own post, "Announcing a New Direction for Zep's Open Source Strategy".)

**What it is.** `graphiti-core` 0.31.2 on Neo4j 5.26 in Docker (port 18620, heap up to 768 MB). Claude (claude-haiku-5-5) reads each episode and extracts entities and facts; embeddings are local BGE small.

**What kind of memory.** A temporal knowledge graph. Every fact is an edge with `valid_at` and `invalid_at`. When a later episode contradicts a fact, Graphiti sets `invalid_at` on the old edge rather than deleting it. Here, the £600 edge showed `invalid since 2026-11-02T14:00`, which is the reference time of the correction episode (each turn was given its own time, an hour apart).

**How it does the task.** Six episodes, one per turn (`add_episode`, `group_id = sam`). Session 2 uses `search_` with the combined hybrid recipe and keeps only edges with no `invalid_at`, plus entity summaries.

**Zep Cloud path.** `run_cloud()` in `run.py` uses `zep-cloud` 4.1.0: create a user and thread, add messages, search the user's graph with `graph.search_edges`. It runs only with `ZEP_API_KEY` set. Without a key the script checks that the client and message objects build, and says so in the result line. I could not run the Cloud calls (no account), so that path is written against the SDK's types and is untested against the service.

**What was surprising.**
- Anthropic's client in Graphiti sends `temperature`, which `claude-haiku-5-5` rejects, so `run.py` wraps the client to drop it.
- Graphiti's default reranker needs OpenAI. A small pass-through reranker avoids that.
- The vegetarian fact never became an edge or an entity (it was not a relationship between two things), so question 4 failed: 4/5. It is a real gap for facts that are attributes rather than relations.
- Without the user's own message as the whole episode body (assistant lines included), extraction was worse: the correction went missing in the first try.
- A fresh graph prints a lot of "index already exists" and "property does not exist" warnings from the Neo4j driver; the script turns them down.

**Limits.** Each episode costs several LLM calls (nodes, edges, dedupe, invalidation), so ingestion is the slow, costly part: about 45 seconds for six turns.

Ran on 2026-11-15: PASS memory/zep: 4/5 answers correct, corrected fact £450 won; graphiti-core, 6 facts, 1 invalidated by the correction; Zep Cloud path builds (set ZEP_API_KEY to run it)
