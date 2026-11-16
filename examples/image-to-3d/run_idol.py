"""Idol (speridlabs/idol): one image to a 3D object made of Gaussian splats, reporting as it goes.

The backend runs this in examples/image-to-3d/.venv (PyTorch is not in the lab's main environment). It reads one job
as JSON on stdin and writes one JSON object per line on stdout: progress, the device, and the result (or an error).
Run it by hand with:

    echo '{"image": "chair.jpg", "out_dir": "out", "steps": 10, "num_gaussians": 65536}' | .venv/bin/python run_idol.py

Job: {"image": path, "out_dir": path, "mode": "real" | "synthetic", "seed": 42, "steps": 50,
      "num_gaussians": 262144, "device": null | "cuda" | "mps" | "cpu"}

Writes object.ply (standard 3DGS, opens in any splat viewer), input.png (the image the model saw, background
removed) and camera.json (the camera it predicted for the photo) into out_dir.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # an operation MPS lacks runs on the CPU instead of failing

GATED = ("facebook/dinov3-vith16plus-pretrain-lvd1689m", "black-forest-labs/FLUX.2-dev")
ACCESS_HELP = ("Idol needs two gated models on Hugging Face. Open each page, accept its terms, then run hf auth login "
               "in this environment: " + ", ".join(f"https://huggingface.co/{r}" for r in GATED) + ".")


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, default=float), flush=True)


ACCESS_ERRORS = {"GatedRepoError", "RepositoryNotFoundError", "LocalTokenNotFoundError"}


def explain(exc: BaseException) -> str:
    """A message fit for the page: what failed, and what to do when it is one of the usual problems. Memory is checked
    first, and an access problem is recognised by Hugging Face's own error types or a whole 401/403, so a message such
    as "Tried to allocate 1401.00 MiB" is not taken for a sign-in problem."""
    text = f"{type(exc).__name__}: {exc}"[:600]
    low = text.lower()
    if "out of memory" in low or isinstance(exc, MemoryError):
        return f"{text}\n\nTry fewer Gaussians or fewer steps: the defaults need about 24 GB on a Mac."
    names = {c.__name__ for c in type(exc).__mro__}
    if names & ACCESS_ERRORS or "gated" in low or re.search(r"\b40[13]\b", low):
        return f"{text}\n\n{ACCESS_HELP}"
    return text


def main() -> int:
    job = json.loads(sys.stdin.read())
    started = time.monotonic()

    def progress(step: str) -> None:
        emit({"type": "progress", "step": step, "elapsed_s": round(time.monotonic() - started, 1)})

    try:
        progress("Loading PyTorch and Idol")
        import torch
        from idol import IdolPipeline
        from idol.device import resolve_device

        device = resolve_device(job.get("device"))
        emit({"type": "setup", "device": device.type, "torch": torch.__version__})
        progress("Loading the weights (downloaded from Hugging Face the first time: about 3 GB, then two image encoders)")
        pipeline = IdolPipeline.from_pretrained(job.get("weights") or "speridlabs/idol", device=device.type)
        loaded_s = time.monotonic() - started
        progress(f"Removing the background, then {job['steps']} sampling steps and decoding "
                 f"{job['num_gaussians']:,} Gaussians")
        t = time.monotonic()
        output = pipeline(job["image"], mode=job["mode"], seed=job["seed"], steps=job["steps"],
                          num_gaussians=job["num_gaussians"])
        generate_s = time.monotonic() - t
        progress("Saving")
        out = Path(job["out_dir"])
        output.gaussian.save_ply(str(out / "object.ply"))
        output.preprocessed_image.save(out / "input.png")
        (out / "camera.json").write_text(json.dumps(output.camera, default=float))
    except BaseException as exc:  # noqa: BLE001  (every failure becomes one error line the page can show)
        emit({"type": "error", "message": explain(exc)})
        return 1
    emit({"type": "result", "device": device.type, "load_s": round(loaded_s, 1), "generate_s": round(generate_s, 1),
          "total_s": round(time.monotonic() - started, 1), "ply_bytes": (out / "object.ply").stat().st_size,
          "camera": output.camera})
    return 0


if __name__ == "__main__":
    sys.exit(main())
