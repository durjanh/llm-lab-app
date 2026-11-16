# Agent memory

Eight ways to give an agent memory, all doing the same task (`shared.py`).

**Session 1.** Sam ("works in the Leeds office") says five things over six turns: vegetarian; a learning-budget request for a £600 course; prefers trains to flights; manager is Priya; parental leave from March. The last turn corrects one: "actually the course costs £450".

**Session 2.** A new conversation, same user id, no history. Five questions that need those memories, two of them also needing a handbook rule (`common.data`): over £500 needs manager approval, so £450 does not; rail is standard class; HR needs 15 weeks' notice. Each answer is checked with regular expressions, and the stale £600 must not be given as the cost.

**PASS** means at least 4 of 5 answers are right and the corrected £450 wins. Claude (`claude-haiku-5-5`) writes the answers (or the agent does, for Letta). Embeddings are local BGE small, except Letta, which uses Azure OpenAI text-embedding-3-large keyless.

## What kind of memory each tool gives

| Tool | Kind | Who decides what to remember | How the correction is handled |
|---|---|---|---|
| `mem0` | Managed memory layer (library) | Mem0, with Claude | Adds a memory that says it replaces the old one; the old one stays |
| `zep` | Temporal knowledge graph (Graphiti) | Graphiti, with Claude | Old fact gets `invalid_at`; kept as history |
| `letta` | Self-editing agent: core blocks plus archival store | The agent itself | The agent rewrites its `human` block |
| `langgraph-memory` | Checkpointer (per thread) plus Store (across threads, semantic search) | Our graph node | Old item flagged, filtered out of search |
| `redis` | Store, plus a chat list with a TTL | Our code with Claude | `active` tag switched off |
| `postgres` | Store (pgvector), relational history | Our code with Claude | New row with `supersedes` link; old row inactive |
| `neo4j` | Hand-built memory graph | Our code with Claude (triples) | Old relationship ends (`current = false`) |
| `chroma` | Store (in process) with metadata | Our code with Claude | `superseded` metadata flag |

Plain stores (Chroma, Redis, Postgres, the LangGraph Store) only save and search; the policy is yours. Mem0 and Graphiti bring the extraction and reconciliation with them. Letta puts the policy in the agent's own hands.

## Results

Ran on 2026-11-15 with `python examples/stack/run_all.py memory`.

| Tool | Result | Time | Detail |
|---|---|---|---|
| `chroma` | PASS | 20s | 5/5 answers correct, corrected fact £450 won; 6 current of 7 stored |
| `langgraph-memory` | PASS | 27s | 5/5 answers correct, corrected fact £450 won; Postgres checkpointer + PostgresStore (semantic index), 12 messages in thread 1, 6 of 7 memories current, thread 2 started with 0 |
| `letta` | PASS | 57s | 5/5 answers correct, corrected fact £450 won; letta server 0.16.8, core block 310 chars, 6 archival passages |
| `mem0` | PASS | 23s | 5/5 answers correct, corrected fact £450 won; mem0ai 2.2.1, 7 memories |
| `neo4j` | PASS | 44s | 5/5 answers correct, corrected fact £450 won; neo4j 5.26.33, 11 facts, 1 ended by a correction |
| `postgres` | PASS | 20s | 5/5 answers correct, corrected fact £450 won; 7 rows, 1 supersedes link(s) |
| `redis` | PASS | 24s | 5/5 answers correct, corrected fact £450 won; redis 8.0.6, 7 hashes (6 active), chat list ttl set |
| `zep` | PASS | 55s | 4/5 answers correct, corrected fact £450 won; graphiti-core, 6 facts, 1 invalidated by the correction; Zep Cloud path builds (set ZEP_API_KEY to run it) |

Things that went wrong on the way, and are worth knowing:
- Zep/Graphiti never stored "vegetarian" (an attribute, not a relation between two things), so it scores 4/5.
- Mem0 keeps both the £600 and £450 memories; the answer is right because the newer one says it replaces the old.
- Neo4j failed first time because Claude named the course differently in two turns; showing it the stored facts fixed that.
- Letta failed first time because the agent chose not to record the cost; a clearer persona prompt fixed that.
- Zep Community Edition is deprecated, and `letta/letta:latest` is now a CLI, not the server; see each NOTES.md.

## How to run

Each tool has its own Python 3.12 environment:

```sh
cd examples/stack/memory/<tool>
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../../../.. && examples/stack/memory/<tool>/.venv/bin/python examples/stack/memory/<tool>/run.py
python examples/stack/run_all.py memory        # every tool, writes examples/stack/RESULTS.md
```

## What each needs

| Tool | Needs |
|---|---|
| all | `ANTHROPIC_API_KEY` in the lab's `.env`; the first run downloads the BGE model (about 130 MB) |
| `mem0`, `chroma` | nothing else (in process) |
| `langgraph-memory`, `postgres` | the lab's `llm-lab-pgvector` container on 127.0.0.1:5433; each makes its own database (`stack_memory`, `stack_memory_pg`) and drops it |
| `redis` | Docker (`redis:8.0`, port 18600), removed at the end |
| `neo4j` | Docker (`neo4j:5.26-community`, port 18610), removed at the end |
| `zep` | Docker (`neo4j:5.26-community`, port 18620). The Zep Cloud path also needs `ZEP_API_KEY`; without it that path is only built, not run |
| `letta` | Docker (`letta/letta:0.16.8`, port 18630), `AZURE_OPENAI_ENDPOINT` and `az login` for embeddings |

Containers are started and removed (`down -v`) by each `run.py`, one at a time, bound to 127.0.0.1.
