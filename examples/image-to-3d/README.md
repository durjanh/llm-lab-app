# One photo to a 3D object (Idol)

`run_idol.py` turns one image into a 3D object made of Gaussian splats with [Idol](https://github.com/speridlabs/idol)
(Speridlabs, Apache 2.0). It removes the background, samples a shape with a diffusion transformer, and decodes it
into 32,768 to 1,048,576 Gaussians, saved as a standard 3DGS `.ply`. The lab's `/image-to-3d` page runs it as a
subprocess and shows the object in the browser.

It needs PyTorch, which the lab's main `.venv` must not get, so it has its own environment in this folder.

## What you need

- Python 3.12.
- A Mac with Apple silicon (it runs through MPS) or an NVIDIA GPU (CUDA). The CPU works, but slowly.
- About 1 GB for the environment and about 5 GB of weights, downloaded on the first run into
  `~/.cache/huggingface/hub`.
- A free Hugging Face account, with access to two gated models (step 2).

## Set up

All commands run from the repo root.

**1. The environment.**

```sh
tools/setup-envs.sh image-to-3d
```

It does the same as `cd examples/image-to-3d && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`.
The `idol` package is not on PyPI, so it is installed from its GitHub repo at a fixed commit.

**2. Access to the two gated models.** Idol's weights are open, but it uses two image encoders whose owners ask you
to accept their terms first. Signed in to Hugging Face, open each page and fill in its form:

- DINOv3: https://huggingface.co/facebook/dinov3-vith16plus-pretrain-lvd1689m (it asks for your affiliation; Meta
  approves it, which can take from minutes to a day)
- FLUX.2-dev: https://huggingface.co/black-forest-labs/FLUX.2-dev (approved at once)

https://huggingface.co/settings/gated-repos shows each request. Wait until both say **Accepted**.

**3. A token, and sign in.** At https://huggingface.co/settings/tokens, create a token:

- a **Read** token works; or
- a **fine-grained** token with *Read access to contents of all public gated repos you can access*. Add *Write access
  to contents/settings of all repos under your personal namespace* too if you will publish LoRA adapters from `/lora`.

Then sign in. The token is kept in `~/.cache/huggingface/token`, which every environment shares. The lab never
reads or sends it.

```sh
examples/image-to-3d/.venv/bin/hf auth login
```

Never paste the token into a file in this repo, or into a chat.

**4. Check.**

```sh
tools/setup-envs.sh check-hf
```

It prints who you are signed in as and whether each gated model can be downloaded. Both should say
`access granted`.

## Run it

With the backend running (`python -m backend --budget 1`), open http://localhost:8000/image-to-3d, pick a photo and
press **Make an object**. The page shows each stage and its time. Objects are kept in `generated/image-to-3d/`.

The first run downloads the weights (about 15 minutes on a fast connection). On an M-series Mac, 10 steps and 65,536
Gaussians then take about 80 seconds to generate, after the weights load.

To run it without the lab:

```sh
cd examples/image-to-3d
echo '{"image": "chair.jpg", "out_dir": "out", "steps": 10, "num_gaussians": 65536}' | .venv/bin/python run_idol.py
```

It prints one JSON line per stage, then the result. It writes `object.ply` (opens in any 3DGS viewer), `input.png`
(the image the model saw, without its background) and `camera.json` into `out_dir`. The job's other fields are
`mode` (`"real"` for a photo, `"synthetic"` for a rendered image), `seed` and `device` (`cuda`, `mps` or `cpu`).

## When it goes wrong

| What you see | What to do |
| --- | --- |
| The page says the environment is missing | Step 1. |
| "Idol needs two gated models…" or `GatedRepoError` | Your request is still pending, or the token cannot read gated repos. Run `tools/setup-envs.sh check-hf`, and see steps 2 and 3. |
| "Not signed in" or `LocalTokenNotFoundError` | Step 3. |
| Out of memory | Fewer Gaussians or fewer steps. Close other apps that use the GPU. |
| The first run seems stuck on "Loading the weights" | It is downloading about 5 GB. `du -sh ~/.cache/huggingface/hub` shows it growing. |
| The object is upside down in another viewer | 3DGS viewers differ on which way is up; the page has a flip switch. |
