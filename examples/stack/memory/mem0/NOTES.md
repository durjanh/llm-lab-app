# Mem0 (open source)

**What it is.** A managed memory layer as a library: `mem0ai` 2.2.1. You give it conversation messages and a `user_id`; it uses an LLM to pull out memories and stores them in a vector store. Here the LLM is Claude (claude-haiku-5-5), the embedder is local BGE small (fastembed), and the vector store is Qdrant in local mode in a temp folder.

**What kind of memory.** Long-term, per user, extracted automatically. `Memory.add(messages, user_id=...)` and `Memory.search(query, filters={"user_id": ...})` are the whole interface.

**How it does the task.** Each session 1 turn goes in as a user/assistant pair. Session 2 searches by user id only and Claude answers from the top four memories and the handbook section.

**What was surprising.**
- Mem0 2.x did not rewrite the £600 memory when the correction came. It added a new memory ("corrected ... to £450, replacing the earlier £600 figure") and left the old one. Both come back in a search, and the answer is right because the newer memory says it replaces the older. So the corrected fact wins through the wording, not through an update.
- `claude-haiku-5-5` rejects `temperature`, and Mem0 sends it for every Haiku model. The config key `enable_sampling_parameters: False` turns that off.
- Mem0 adds the current date to memories ("on November 15, 2026"), which then appears in answers.
- The log warns that spaCy is not installed (`mem0ai[nlp]`); entity linking is skipped. Not needed for this task.

**Limits.** You cannot see why it kept or dropped something without reading its prompts. There is a hosted Mem0 platform too; this uses only the open-source library.

Ran on 2026-11-15: PASS memory/mem0: 5/5 answers correct, corrected fact £450 won; mem0ai 2.2.1, 7 memories
