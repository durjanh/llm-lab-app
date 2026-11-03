# LLM Lab: Python scripts and local server

Runnable companions to the browser labs, using the official `anthropic` Python SDK. Each script prints what it sent, what came back, and an estimated cost.

## Setup

Run these from the `llm-lab-app` folder. On a Mac, use `python3` until the environment is active.

First time only:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
```

Put your API key in a `.env` file in the `Transformer` folder. Git ignores this file, and every script reads it automatically:

```sh
ANTHROPIC_API_KEY=your-key-here
```

A key exported in your shell with `export ANTHROPIC_API_KEY=...`, or a profile from `ant auth login`, also works.

Every time after that, activate the environment, then run any script:

```sh
source .venv/bin/activate
python python/01_count_tokens.py
```

Python 3.10 or newer is required. Scripts default to `claude-haiku-5-5`, the cheapest current model. Use `--model claude-sonnet-5-5` or `--model claude-opus-5-5` for harder tasks. Pass `--model` to any script, or set `LLM_LAB_MODEL`, to use another model. Every script has `--help`.

To save credit, start with the scripts that cost nothing or almost nothing:
- `01_count_tokens.py` only counts tokens and generates no text.
- `05_rag.py --retrieve-only` runs retrieval without calling Claude.

## Scripts

| Script | Companion lab | What it does |
|---|---|---|
| `01_count_tokens.py` | Tokens | Counts tokens with Claude's own tokenizer, comparing data formats and languages. Pass file paths to count your own files. Generates no text. |
| `02_self_consistency.py` | Sampling | Asks one question several times in parallel and takes the majority answer. |
| `03_classify_reviews.py` | Prompting, Evals | Labels reviews with structured outputs and reports accuracy with a confidence interval. Add `--few-shot` to compare prompts. |
| `04_caching_and_latency.py` | Context & cost | Streams a four-turn conversation over a long handbook and prints time to first text, cache reads and writes, and cost per turn. Add `--no-cache` to compare. |
| `05_rag.py` | Embeddings & RAG | Retrieves handbook passages with embeddings, BM25 keywords or both, then answers with citations. Skips the model call when nothing relevant is found. Add `--retrieve-only` to run without an API key. |
| `06_agent_loop.py` | Agents & tools | A hand-written tool-use loop with three scenarios, error results, an email allow-list and a human approval prompt. |
| `07_tool_runner.py` | Agents & tools | The same agent using the SDK's tool runner, which writes the loop for you. |
| `08_eval_with_judge.py` | Evals | Grades answers with Claude as a rubric judge, measures agreement with human labels, and tests for position bias. |
| `09_autonomous_agent.py` | Harness engineering | An agent that works until the job is done: it fixes a small project with failing tests in a temporary folder. The harness keeps a todo list, accepts "finish" only when the tests really pass, and stops at a turn limit or spending cap. |
| `10_rag_vs_cag_vs_kag.py` | Embeddings & RAG, Context & cost | Answers the same handbook questions three ways: RAG (retrieve the top-k sections), CAG (the whole handbook as a cached system prompt) and KAG (Claude builds a knowledge graph, plans the question as graph steps, the code walks it hop by hop, and the answer cites each fact). Prints the walk and a totals table of calls, tokens, cost and time. Add `--graph graph.json` to build the graph once and reuse it. RAG needs `fastembed` and is skipped without it. |
| `11_harness_loop.py` | Harness engineering | A harness built like Claude Code: one loop and ten tools, seven in code and three sub-agents (`math_agent`, `bash_agent` with Anthropic's bash tool, `web_agent` with server-side web search). Prints the JSON of every tool call. Read-only calls run in parallel, sub-agents start with an empty context, and permission rules and hooks run before every call. Scenarios: `chain`, `parallel`, `team`, `bash`, `web`, or pass your own number and task. Web search must be enabled for your organisation in the Claude Console. |
| `12_agent_skills.py` | Harness engineering | Agent Skills on the Claude API. Claude uses one of Anthropic's skills (`--skill xlsx`, `pptx`, `docx` or `pdf`) in the code-execution container to make a real file about the numbers 2 to `--upto`, and the script downloads it to `skill_outputs/`. Add `--custom` to upload your own skill from `skills/number-profile/` (a SKILL.md plus a script Claude runs) and use both; it is reused on later runs, and `--cleanup` deletes it. Resumes paused turns in the same container. |
| `13_rate_limits.py` | Rate limits | Starts fake rate-limited Claude endpoints on this machine and sends the same spike of requests through them seven ways: no retries, the SDK's retries, then backoff, a second region, a smaller model and a circuit breaker from `resilience.py`, including a region outage. Prints answers, waits, calls and 429s for each. Needs no API key and costs nothing. |
| `14_batch_api.py` | Rate limits | The review classification from script 03 sent as one Message Batch: half price, its own rate limits, results matched by `custom_id`. `--dry-run` sends nothing; `--no-wait` submits and exits, and `--resume BATCH_ID` collects later. |
| `15_vision.py` | Images as Tokens | Reads a till receipt (`images/receipt.png`) into structured data four ways: Claude, and GPT on Azure OpenAI through Chat Completions with image detail high and low, and through the Responses API. Scores each field against the known answers, checks the sums in code, and compares tokens and cost. `--image` reads your own receipt; the GPT readers need `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENTS` and `az login`. |

`resilience.py` holds the patterns script 13 uses, ready to copy: backoff with full jitter that honours `retry-after-ms` and `retry-after`, a circuit breaker per endpoint, and failover through an ordered list of endpoints. `settings.py` is the one place that reads environment variables and `.env`, for these scripts and for the backend.

Each run makes a handful of small calls, so most scripts cost a small fraction of a cent on Claude Haiku 5.5, and up to a few cents on Claude Opus 5.5. Check the printed estimate after each run.

## The backend

The live pages call Claude through the FastAPI backend in `backend/`, which replaced the old `server.py`. It shares this folder's `common.py` for prices and fallback routing, `settings.py` for environment variables, and `data.py` for the sample handbook. The main `README.md` has the commands; in short:

```sh
source .venv/bin/activate
python -m backend --budget 1     # open http://localhost:8000; stops after about $1
```

## Notes

- Requests to Claude Opus 5.5 and Claude Sonnet 5.5 use the beta endpoint with `fallbacks="default"`. If the model declines a request on safety grounds, the API retries it on a recommended fallback model. Claude Haiku 5.5, the default, has no server-side fallback, so its requests use the standard endpoint and a refusal is reported as one.
- `temperature`, `top_p` and `top_k` are not used. Version 1 of the Python SDK removed them, and current Claude models reject them.
- Prices in `common.py` are Anthropic list prices as of October 2026. The Claude Haiku 5.5 cache-read price is an assumption. Check the pricing page before relying on any estimate.
- These scripts were tested end to end against a local mock of the Claude API, which checks the request shapes and control flow. They have not yet been run against the live API from this machine.
