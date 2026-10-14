# LLM Lab

Hands-on pages that show how large language models work, each ending with the engineering decisions it should change. Every page runs real models or real arithmetic in your browser. A small local server adds live Claude calls.

## Start

The best way is through the local server, which also serves the pages:

```sh
cd python && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cd ..
python python/server.py          # then open http://localhost:8000
```

You can also open `index.html` straight from disk. Everything works that way except the live Claude features and the full GPT-2 explainer, which need the server.

## The labs

| Group | Page | What it shows | Downloads |
|---|---|---|---|
| Foundations | `transformer.html` | Animated transformer. Tiny model, GPT-2 probabilities, or GPT-2 with every internal value real | Optional: 128 MB, or 134 MB local model |
| | `training.html` | Train a tiny language model live; watch it learn, then overfit and memorise | None |
| | `tokens.html` | Tokenizer playground, formats by token count, context budget | 2 MB tokenizer |
| | `sampling.html` | Greedy against sampled decoding, confidence per token | GPT-2, 128 MB |
| Building | `prompting.html` | Few-shot measured on a test set, constrained decoding, prompt injection | GPT-2, 128 MB |
| | `embeddings.html` | Meaning map, RAG with embeddings, BM25 and hybrid search, plus a reranker | 23 MB, plus 24 MB reranker |
| | `agents.html` | Tool-use loop step by step: parallel calls, errors, approval | None |
| Quality and safety | `evals.html` | Test sets, three kinds of grader, confidence intervals, run-to-run variance | GPT-2, 128 MB |
| | `confidence.html` | Calibration, reliability diagrams, routing doubtful answers to a person | GPT-2, 128 MB |
| | `injection.html` | Attack a toy agent and see which defences hold | None |
| Cost and operations | `context.html` | Prefill and decode, KV cache memory, conversation cost with caching | None |
| | `routing.html` | Large, small, cascade or router, compared on cost per correct answer | None |
| | `live.html` | Real Claude calls: latency, tokens, effort, caching and cost | Needs the server and an API key |

Models load from Hugging Face through transformers.js 4.3.0 on jsDelivr the first time a page needs them, and the browser caches them.

## Live Claude features

Live calls use your Anthropic API key, kept in the server and never sent to the browser. Put it in a `.env` file at the project root, which git ignores:

```sh
ANTHROPIC_API_KEY=your-key-here
```

The server listens on localhost only, rejects requests from other websites, caps `max_tokens`, and stops after an estimated spend you set with `--budget`. The default is $2 per session. Each live action costs roughly a fraction of a cent to a few cents on Claude Opus 5.5.

## Other folders

- `python/`: runnable scripts for each lab and the server. See `python/README.md`.
- `tools/`: rebuilds the 134 MB GPT-2 model with its internals exposed, which is not in git. See `tools/README.md`.
- `js/`, `css/`: one script per page, plus shared code: `common.js` for the nav, theme and model loading cards, `gpt2.js`, `embedder.js`, `reranker.js` and `live.js`.

Pages follow your system's light or dark setting. The nav bar's theme button switches between automatic, dark and light.

## What has been tested

- Every page in headless Chrome, opened from disk and over HTTP, with no JavaScript errors. That covers light and dark themes, and a 390-pixel phone width with no sideways scrolling.
- The Python scripts and server, end to end against a mock Claude API that recorded every request. Against the real API, token counting, the parallel tool loop, prompt caching and the Live Claude page were checked in October 2026. That cost about $0.07.
- The full GPT-2 explainer's attention values, against the same model run in Python.

## Sharing

The pages are static files, so they can be published on GitHub Pages or any static host. A hosted copy cannot run the live Claude features or the full GPT-2 explainer, because those need the local server and the local model file.

Prices and model facts on the pages reflect Anthropic's documentation as of October 2026. Check the pricing page before relying on them.
