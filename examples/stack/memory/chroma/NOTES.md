# Chroma as a memory store

**What it is.** An open-source vector database. Used here in process (`PersistentClient` on a temp folder), so there is no server and nothing to start. Chroma 1.5.9.

**What kind of memory.** A plain store. Chroma does not decide what to remember. It holds text, vectors and metadata, and answers "which rows are closest to this question, where metadata matches".

**How it does the task.** Claude reads each session 1 message and the current memories (`shared.extract`) and returns facts to add and ids to supersede. Each fact is a row with `user_id`, `session` and `superseded` metadata, embedded locally with BGE small. When Sam corrects the cost, the £600 row gets `superseded: true`. Session 2 queries with `where user_id = sam and superseded = false`, so the stale cost never comes back.

**Limits.** All of the "memory" logic (what to keep, what to replace) is our code and one Claude call per turn. Chroma's custom embedding hook needed a `name()` and a no-argument constructor to be accepted by 1.5.9. Metadata filters are exact matches only.

Ran on 2026-11-15: PASS memory/chroma: 5/5 answers correct, corrected fact £450 won; 6 current of 7 stored
