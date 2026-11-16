# Letta (formerly MemGPT)

**State of Letta (checked 2026-11-15).** `letta/letta:latest` is now Letta Code, a command line tool (the container prints help and exits). Letta's docs say the Python REST server is end of life. The last server image is `letta/letta:0.16.8` (about 600 MB, port 8283 inside, 18630 here), which this uses. Letta's hosted `letta/letta-free` embedding endpoint now answers 404, so the server cannot embed on its own.

**What it is.** A stateful agent server. The agent has core memory blocks (`human`, `persona`) that sit in its prompt and that it edits itself with tools (`memory_replace`, `memory_insert`), plus archival memory, a vector store it can search. Claude (claude-haiku-5-5) runs the agent through `ANTHROPIC_API_KEY`, which `run.py` passes to the container from the environment. Archival embeddings use Azure OpenAI text-embedding-3-large, keyless: an Entra token goes to the container as `OPENAI_API_KEY`.

**What kind of memory.** The agent manages its own memory. We do not extract anything.

**How it does the task.** Each session 1 turn is a message to the agent. The raw turns were also inserted into archival memory (6 passages). Session 2 resets the message history (a new conversation, same agent) and puts each question, with the handbook section, to the agent. The agent answered itself, and its replies were scored.

**What was surprising.**
- The first run failed (4/5, £450 lost). The agent judged the course cost not worth recording and never searched archival memory. The persona prompt now says to record amounts exactly and to search archival memory before saying it does not know. After that, it wrote £450 into the `human` block by `memory_replace`.
- The agent gets the correction right only because it chooses to edit; nothing enforces it.
- The server reported about 515 MB of memory while idle.

**Limits.** The server is end of life, so this example is pinned and will not move forward. Each message costs several model calls plus Letta's long system prompt, so it was the slowest and priciest example here (still a few cents).

Ran on 2026-11-15: PASS memory/letta: 5/5 answers correct, corrected fact £450 won; letta server 0.16.8, core block 310 chars, 6 archival passages
