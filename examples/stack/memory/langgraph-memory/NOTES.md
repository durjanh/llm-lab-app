# LangGraph memory: checkpointer and Store

**What it is.** LangGraph 1.2.22 with `langgraph-checkpoint-postgres` 3.2.1. Two separate things:

- **Checkpointer** (`PostgresSaver`): short-term memory. It saves the graph state, including the messages, per `thread_id`. Session 1's thread has 12 messages; session 2's new thread starts at 0.
- **Store** (`PostgresStore` with a semantic `index`): long-term memory shared across threads. Items live under a namespace, `("memories", "sam")`, and `store.search(namespace, query=..., filter=...)` is a similarity search over local BGE vectors in pgvector.

**Which Postgres.** The real Postgres versions, not `InMemoryStore`: the lab's `llm-lab-pgvector` container, in its own database `stack_memory`, dropped at the end.

**How it does the task.** A two-node graph: `chat` replies with Claude using the thread's history and the Store's memories; `remember` asks Claude what to add or supersede (`shared.extract`) and writes it to the Store. A superseded item is rewritten with `superseded: true` (and no re-embedding), and searches filter it out.

**Limits.** LangGraph gives the plumbing, not the memory policy. What counts as a fact, and how a correction is handled, is the `remember` node we wrote. The Store is a key-value store with search, not a graph.

Ran on 2026-11-15: PASS memory/langgraph-memory: 5/5 answers correct, corrected fact £450 won; Postgres checkpointer + PostgresStore (semantic index), 12 messages in thread 1, 6 of 7 memories current, thread 2 started with 0
