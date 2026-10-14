# LLM Lab: Python scripts and local server

Runnable companions to the browser labs, using the official `anthropic` Python SDK. Each script prints what it sent, what came back, and an estimated cost.

## Setup

```sh
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=your-key-here   # or run `ant auth login`
```

Python 3.10 or newer is required. Scripts default to `claude-opus-5-5`. Pass `--model` to any script, or set `LLM_LAB_MODEL`, to use another model.

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
| `server.py` | Live Claude | Serves the whole lab at http://localhost:8000 and proxies Claude calls for the live pages. |

Each run makes a handful of small calls, so most scripts cost a fraction of a cent to a few cents on Claude Opus 5.5. Check the printed estimate after each run.

## The local server

```sh
python server.py                 # open http://localhost:8000
python server.py --budget 5      # raise the spending cap for this session
```

- It serves every lab page, which avoids browser restrictions on pages opened straight from disk.
- The Live Claude page and live options on other pages call Claude through it. The API key stays in the server process.
- It listens on 127.0.0.1 only, rejects requests from other websites, caps `max_tokens`, and stops making calls when the estimated session spend reaches `--budget` dollars. The default cap is $2.

## Notes

- Requests to Claude Opus 5.5 and Claude Sonnet 5.5 use the beta endpoint with `fallbacks="default"`. If the model declines a request on safety grounds, the API retries it on a recommended fallback model. Claude Haiku 5.5 has no server-side fallback, so its requests use the standard endpoint.
- `temperature`, `top_p` and `top_k` are not used. Version 1 of the Python SDK removed them, and current Claude models reject them.
- Prices in `common.py` are Anthropic list prices as of October 2026. The Claude Haiku 5.5 cache-read price is an assumption. Check the pricing page before relying on any estimate.
- These scripts were tested end to end against a local mock of the Claude API, which checks the request shapes and control flow. They have not yet been run against the live API from this machine.
