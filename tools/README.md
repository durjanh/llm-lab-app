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

The explainer's "GPT-2 full internals" option loads this file with onnxruntime-web. Browsers block a page opened from disk from reading local model files, so serve the folder first:

```sh
python python/server.py   # then open http://localhost:8000/transformer.html
```
