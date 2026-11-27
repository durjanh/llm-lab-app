# Tools

| Script | What it does |
| --- | --- |
| `setup-local.sh` | Sets up everything the lab runs in Docker on a new machine, in order: `vector-db.sh`, `local-model.sh --embed`, `local-model.sh`, `sandbox.sh`, then `shop-data.sh` (filling the shop only if it is empty) and `vector-samples.sh`. Safe to run again after a restart or a change; never edits `.env`, but lists the lines it still needs. `--no-chat-model`, `--no-data`. |
| `setup-envs.sh` | Sets up the Python 3.12 environments that some labs run in (`claude-agent-sdk`, `tabular`, `lora`, `image-to-3d`, `voice-agent`). With no arguments it lists them; `all` sets up every one; `check-hf` checks the Hugging Face sign-in and the gated models Idol needs. See the main README, "Labs with their own environment". |
| `local-model.sh` | Runs an open model with Docker Model Runner, for `LLM_LAB_LOCAL_MODEL`. |
| `sandbox.sh` | Runs the coding agent's sandbox image in Docker on `127.0.0.1:8099`, for `LLM_LAB_SANDBOX=docker`. |
| `vector-db.sh` | Runs PostgreSQL with pgvector in Docker, for `/vector-db`. |
| `shop-data.sh` | Sets up and fills the Shopping Assistant's database (`/shop-assistant`) without the page: starts PostgreSQL and the embedding model, creates or upgrades the `shop` schema, generates an invented shop (`generate 20000`), imports your own files (`import products f.jsonl`), embeds pending products (`embed`) and builds the vector index (`reindex`). Every command is safe to run again (below). |
| `vector-samples.sh` | Loads the sample documents into the vector database without the page: the `/vector-db` sets (`handbook`, `medassist`, `restricted`, with their access groups) and the `/graphrag` corpus. Safe to run again (a document replaces itself); no paid calls. Building the GraphRAG graph stays on its page, because it calls a model. |
| `deploy-frontend.sh` | Builds the frontend and deploys it to the lab's Azure Static Web App, the public site linked from the main README. Only the pages go there, not the backend. Uses your `az login`; the deployment token is fetched for the run and never printed. Run it after changing the frontend. |
| `export_gpt2_explainer.py` | Rebuilds the GPT-2 model with its internals exposed (below). |

# The shop's database

`shop-data.sh` runs `shop_data.py`, which uses the backend's own shop code and `.env`, so what it makes is exactly what the page makes. On a new machine, or after cloning:

```sh
./tools/shop-data.sh                 # starts PostgreSQL (vector-db.sh) and the embedding model, creates the schema
./tools/shop-data.sh generate 20000  # or 100000 or 1000000 (about 1.5 hours of embedding on a Mac)
./tools/shop-data.sh status
```

Run it again whenever something changes:

| You changed | Run |
| --- | --- |
| Nothing yet: new machine or a fresh clone | `./tools/shop-data.sh`, then `generate <size>` |
| The schema (`shop_schema.py`; bump `SCHEMA_VERSION`) | `./tools/shop-data.sh`: it brings the schema up to date, as the backend does when it starts |
| Your own products, shoppers or orders | `./tools/shop-data.sh import <kind> <file>`, where the kind is `products`, `customers` or `orders` (JSON Lines or CSV). Rows with the same id are replaced; a file with any bad row is refused whole, with each row's reason |
| Products while the backend was stopped, or `LLM_LAB_LOCAL_EMBED_MODEL` | `./tools/shop-data.sh embed`: it embeds only what is new, changed, or made with another model. While the backend runs, its worker does this by itself |
| Some products failed to embed | `./tools/shop-data.sh embed --retry` |
| The generator (`shop_data.py`: wording, attributes, prices) | `./tools/shop-data.sh refresh`: it rewrites the generated products and re-embeds only those whose text changed, keeping shoppers, orders and stock. It overwrites Lab tab edits to generated products; `generate <size>` starts again from nothing instead |
| A generation was stopped (Ctrl+C, a restart) | The same `generate <size>` again: it carries on from the last batch |

`generate` replaces every shopper, basket and order, so it refuses while the backend is running unless you add `--force` (or use the page's Lab tab). The script and the backend share a lock in the database, so only one of them generates or imports at a time; the other says so and waits for you to try again.

The vector index is built with parallel workers, which need more shared memory than Docker gives a container by default. `vector-db.sh` gives new containers 1 GB; on one made before that, the index builds without workers instead (slower), and `vector-db.sh` says how to recreate the container with its data kept.

# Exporting GPT-2 with its internals

The standard browser build of GPT-2 only returns next-token scores. `export_gpt2_explainer.py` builds a version that also returns every value the Transformer Explainer draws: token and position embeddings, each layer's queries, keys and values, attention weights, the attention projection, residuals, layer-norm outputs, the MLP before and after its projection, block outputs, the final state and the logits.

The result is `models/gpt2-explainer/gpt2-explainer-q8.onnx`, about 134 MB, plus `manifest.json`. The model file is too large for git, so `models/` is ignored and this script is how you rebuild it.

## Rebuild the model

```sh
python3 -m venv .venv-export && source .venv-export/bin/activate
pip install -r tools/requirements.txt
python tools/export_gpt2_explainer.py
```

It downloads `openai-community/gpt2` from Hugging Face, which is about 550 MB. Options:

- `--out <folder>` sets where the model goes. The default is `models/gpt2-explainer`.
- `--work <folder>` keeps the full-precision intermediate file. By default it uses a temporary folder.

## What the script checks

1. Its own PyTorch module against the Hugging Face reference model, on three prompts.
2. The full-precision ONNX export against PyTorch.
3. The 8-bit model against full precision, including that the top five next tokens agree.

The numbers are written to `manifest.json` under `validation`. On the shipped model, logits matched the reference to within about 0.0003, and the top five tokens matched on every prompt.

## Using it

The explainer's "GPT-2 full internals" option loads this file with onnxruntime-web. The backend serves the `models/` folder, so start it and open the explainer:

```sh
python -m backend   # then open http://localhost:8000/transformer
```
