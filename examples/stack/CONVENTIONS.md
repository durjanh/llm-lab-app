# How the AI stack examples are built

`examples/stack/` has one runnable example for each tool in a common AI tech stack that the rest of the lab does not already cover. Every example in an area does the **same task on the same data**, so the tools can be compared line for line, the way `examples/sdks/` compares agent SDKs.

## Layout

```
examples/stack/
  common/              standard library only: config.py (settings, ports), data.py (handbook, chunks, GOLD), checks.py (result line)
  run_all.py           runs every tool with its own .venv and writes RESULTS.md
  <area>/
    README.md          the area's task, the table of tools, how to run, what each needs
    shared.py          the area's task and checks (optional; standard library only)
    <tool>/
      run.py           the example; its LAST line is PASS, FAIL or SKIP (common/checks.py)
      requirements.txt pinned versions; first line says how to make the venv
      NOTES.md         what the tool is, how it does this task, what you saw when it ran, and limits
      docker-compose.yml   only if the tool needs a server
      .venv/           Python 3.12, gitignored: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

`run.py` imports the shared pieces with:

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
from common import checks, config, data
```

## Rules

- **Same task, same data.** Use `common.data` (the handbook, `chunks()`, `GOLD`) wherever the area is about text. Don't invent a different corpus per tool.
- **One result line.** End with `checks.report("<area>/<tool>", ok, detail)` or `checks.skip("<area>/<tool>", why)`. `run_all.py` reads it.
- **SKIP, don't fail, when something is missing** that the machine cannot have: an account, an API key, a GPU, a paid service. The reason says exactly what to set or install (`set PINECONE_API_KEY`). Still write the full code path, so it runs as soon as the key is there, and check that it at least imports and builds its request.
- **Models.** Generation and judging use Claude (`config.CLAUDE_MODEL`, `claude-haiku-5-5` by default, `ANTHROPIC_API_KEY` from the lab's `.env`). Use Azure OpenAI (`config.AZURE_*`, Entra sign-in with `DefaultAzureCredential`, never a key) only where a tool needs an OpenAI-shaped model. Local embeddings use `config.LOCAL_EMBEDDING` (BGE small). Keep calls few and short: a whole area should cost well under one US dollar per run.
- **Keys are read at run time, never written.** No key, token or password goes into a file in the repository, a log, a NOTES.md or the output. Don't open or print `.env`; `common.config` loads it. Docker containers get throwaway local passwords that live only in `docker-compose.yml` (for example `lab`/`lab`) and bind to `127.0.0.1` only.
- **Docker.** Use only your area's ports (`common.config.PORTS`). Name containers `stack-<area>-<tool>`. The machine has about 8 GB for Docker, shared with other work: start one server at a time, prefer an in-process or "lite" mode when the tool has one, give JVM servers a small heap, and `docker compose down -v` when the run ends (run.py may start and stop its own container). Never touch the lab's containers `llm-lab-pgvector` and `llm-lab-sandbox`, except reading or writing your own table or database in `llm-lab-pgvector` where the brief says so, and dropping it afterwards.
- **Virtual environments.** Each tool has its own `.venv` (Python 3.12) because these packages pin conflicting versions. Never install into the root `.venv`. Node tools use `npx` with a pinned version.
- **Writing.** NOTES.md and comments are plain British English, short sentences, saying what something does and why. Say "Microsoft Foundry", never "Azure AI Foundry". Each NOTES.md ends with "Ran on <date>: <result>" and anything surprising you saw.
- **Honesty.** If a tool is archived, renamed or has moved (EmbedChain, for example), say so in NOTES.md and show what replaced it. If something could only be explained, not run, say that plainly.
- **Don't commit.** Leave the work in the working tree.
