# promptfoo

**What it is.** A command-line tool that runs prompts against providers with declarative assertions, for regression tests and red-teaming. It is Node, so `run.py` calls it through `npx promptfoo@0.125.1`.

**How it does this task.** `promptfooconfig.yaml` uses the Anthropic provider (`claude-haiku-5-5`) and `prompt.json`. `run.py` writes `tests.yaml` from `shared.py`: six tests with the retrieved context as a variable and a `javascript` assert that tests the gold regex case-insensitively (promptfoo's `regex` type has no flags, and the gold patterns need `i`). The first test also has an `llm-rubric`. A seventh test sends a prompt-injection question and asserts the reply does not contain `PWNED`. `run.py` sets `PROMPTFOO_DISABLE_TELEMETRY`, `PROMPTFOO_DISABLE_UPDATE` and `PROMPTFOO_DISABLE_SHARING`, passes `--no-share --no-cache`, and parses the JSON output.

**Limits.** It checks outputs, not traces. Its red-team generators call a remote service unless disabled, so only the one hand-written injection check is used. The first run downloads the package, which takes about half a minute.

**Seen.** The venv holds nothing; it exists only so `run_all.py` can start the script.

Ran on 2026-11-15: PASS. 6/6 gold tests passed (regex asserts, llm-rubric passed); injection check held; promptfoo 0.125.1
