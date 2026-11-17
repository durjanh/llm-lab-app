# Tools

| Script | What it does |
| --- | --- |
| `setup-envs.sh` | Sets up the Python 3.12 environments that some labs run in (`claude-agent-sdk`, `tabular`, `lora`, `image-to-3d`, `voice-agent`). With no arguments it lists them; `all` sets up every one; `check-hf` checks the Hugging Face sign-in and the gated models Idol needs. See the main README, "Labs with their own environment". |
| `local-model.sh` | Runs an open model with Docker Model Runner, for `LLM_LAB_LOCAL_MODEL`. |
| `sandbox.sh` | Runs the coding agent's sandbox image in Docker on `127.0.0.1:8099`, for `LLM_LAB_SANDBOX=docker`. |
| `vector-db.sh` | Runs PostgreSQL with pgvector in Docker, for `/vector-db`. |
| `export_gpt2_explainer.py` | Rebuilds the GPT-2 model with its internals exposed (below). |

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
