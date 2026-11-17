# LoRA fine-tuning on this machine

`run_lora.py` fine-tunes a small open model (SmolLM2 135M or 360M Instruct, Apache 2.0) with LoRA, so that it
turns invented customer emails into one JSON object in a fixed shape. `lora_data.py` writes the emails and their
right answers and scores the model, so every score is checked by code, not by a model. The lab's `/lora` page runs it
as a subprocess, and `publish_adapter.py` uploads a saved adapter to Hugging Face.

It needs PyTorch, which the lab's main `.venv` must not get, so it has its own environment in this folder.
`lora_data.py` has no PyTorch, so the backend imports it too.

## What you need

- Python 3.12.
- Apple silicon (MPS), an NVIDIA GPU (CUDA) or the CPU. A training run takes a few minutes on an M-series Mac.
- About 1 GB for the environment. The base models (270 MB or 720 MB) download on first use, with no sign-in, into
  `generated/lora/`.

## Set up

From the repo root:

```sh
tools/setup-envs.sh lora
```

It does the same as `cd examples/lora && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## Run it

With the backend running (`python -m backend --budget 1`), open http://localhost:8000/lora. Choose the rank, alpha,
layers, learning rate and steps, and press Train. The page shows the loss falling and the scores before and after.
Adapters are kept in `generated/lora/`.

To run it without the lab:

```sh
cd examples/lora
echo '{"action": "train", "steps": 60}' | .venv/bin/python run_lora.py
```

It prints one JSON line per stage and training step, then the result. The script's docstring lists every job field.
QLoRA (`"quantize": "4bit"`) needs an NVIDIA GPU, so on a Mac the page trains plain LoRA.

## Publish an adapter to Hugging Face

This is optional. The page's Publish button uploads only three files: the adapter weights, `adapter_config.json`
(which names the base model by its Hub id, not a folder on your machine) and a model card written from the
adapter's own scores. The repo is private unless you untick it, and nothing is sent until you confirm.

1. At https://huggingface.co/settings/tokens, create a **Write** token, or a **fine-grained** token with *Write
   access to contents/settings of all repos under your personal namespace*.
2. Sign in. The token is kept in `~/.cache/huggingface/token` and the lab never sees it. Never paste it into a file
   in this repo, or into a chat.

   ```sh
   examples/lora/.venv/bin/hf auth login
   ```

3. Check: `tools/setup-envs.sh check-hf` says whether publishing is allowed.
4. On `/lora`, choose **publish** beside a saved adapter, check the repo name and the card, and confirm.

Without the page, `publish_adapter.py` takes one job on stdin (its docstring lists them):

```sh
echo '{"action": "whoami"}' | .venv/bin/python publish_adapter.py
```

If the upload fails with a 403, the token can read but not write: give it write access (step 1) and try again.
