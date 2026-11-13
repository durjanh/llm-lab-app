"""LoRA fine-tuning of a small open model on the lab's invented email task, reporting as it goes.

The backend runs this in examples/lora/.venv (PyTorch is not in the lab's main environment). It reads one job as JSON
on stdin and writes one JSON object per line on stdout: progress, the scores before training, each training step's
loss, the scores after, a check that merging the adapter changes nothing, and the result. Run it by hand with:

    echo '{"action": "train", "steps": 60}' | .venv/bin/python run_lora.py

Jobs:
    {"action": "train", "model_id": ..., "r": 16, "alpha": 32, "dropout": 0.05, "targets": [...], "lr": 5e-4,
     "steps": 150, "batch": 8, "seed": 0, "eval_n": 40, "out_dir": ..., "models_dir": ..., "quantize": "none"}
    {"action": "try", "model_id": ..., "adapter_dir": ... or null, "email": ..., "models_dir": ...}

quantize "4bit" is QLoRA: the frozen model in 4-bit NF4 through bitsandbytes, which needs an NVIDIA GPU (CUDA).
"""
from __future__ import annotations

import json
import os
import random
import resource
import sys
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import lora_data  # noqa: E402  (beside this script)

GENERATE_TOKENS = 96
EVAL_BATCH = 20


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event), flush=True)


def progress(step: str) -> None:
    emit({"type": "progress", "step": step})


def device_and_dtype(torch: Any) -> tuple[str, Any]:
    """The fastest device here. Small models train in float32 on a Mac (bfloat16 on MPS is slower and less stable)."""
    if torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if torch.backends.mps.is_available():
        return "mps", torch.float32
    return "cpu", torch.float32


def memory_mb(torch: Any, device: str) -> float:
    if device == "cuda":
        return round(torch.cuda.max_memory_allocated() / 1e6, 1)
    if device == "mps":
        return round(torch.mps.driver_allocated_memory() / 1e6, 1)
    # ru_maxrss is bytes on macOS, kilobytes on Linux
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1e6 if sys.platform == "darwin" else 1e3), 1)


def download(model_id: str, models_dir: Path) -> Path:
    from huggingface_hub import snapshot_download

    target = models_dir / model_id.split("/")[-1]
    if not (target / "model.safetensors").exists():
        progress(f"Downloading {model_id} (once; it is kept in {target})")
        snapshot_download(model_id, local_dir=target,
                          allow_patterns=["*.json", "*.safetensors", "*.txt", "tokenizer*", "merges.txt", "vocab.json"])
    return target


def load(job: dict[str, Any]) -> tuple[Any, Any, Any, str, Path]:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    model_id = job.get("model_id") or "HuggingFaceTB/SmolLM2-135M-Instruct"
    path = download(model_id, Path(job["models_dir"]))
    device, dtype = device_and_dtype(torch)
    tokenizer = AutoTokenizer.from_pretrained(path)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    kwargs: dict[str, Any] = {"dtype": dtype}
    if job.get("quantize") == "4bit":
        if device != "cuda":
            raise RuntimeError("QLoRA's 4-bit loading (bitsandbytes) needs an NVIDIA GPU with CUDA. This machine has "
                               f"{device.upper()}, so train with LoRA on the full-precision model instead.")
        from transformers import BitsAndBytesConfig

        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16)
        kwargs["device_map"] = {"": 0}
    progress(f"Loading {model_id} on {device.upper()}")
    model = AutoModelForCausalLM.from_pretrained(path, **kwargs)
    if job.get("quantize") != "4bit":
        model.to(device)
    model.eval()
    return torch, model, tokenizer, device, path


def prompt(tokenizer: Any, email: str) -> str:
    return tokenizer.apply_chat_template([{"role": "system", "content": lora_data.SYSTEM},
                                          {"role": "user", "content": email}], add_generation_prompt=True,
                                         tokenize=False)


def generate(torch: Any, model: Any, tokenizer: Any, device: str, emails: list[str]) -> list[str]:
    """Greedy answers, in batches, with the prompt padded on the left so every answer starts at the same place."""
    tokenizer.padding_side = "left"
    outputs: list[str] = []
    for start in range(0, len(emails), EVAL_BATCH):
        batch = [prompt(tokenizer, e) for e in emails[start:start + EVAL_BATCH]]
        enc = tokenizer(batch, return_tensors="pt", padding=True, add_special_tokens=False).to(device)
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=GENERATE_TOKENS, do_sample=False,
                                 pad_token_id=tokenizer.pad_token_id, eos_token_id=tokenizer.eos_token_id)
        new = out[:, enc["input_ids"].shape[1]:]
        outputs += [t.strip() for t in tokenizer.batch_decode(new, skip_special_tokens=True)]
    return outputs


def evaluate(torch: Any, model: Any, tokenizer: Any, device: str, test: list[dict], phase: str) -> dict[str, Any]:
    progress(f"Scoring the {'base model' if phase == 'before' else 'trained adapter'} on {len(test)} held-out emails")
    started = time.perf_counter()
    outputs = generate(torch, model, tokenizer, device, [t["email"] for t in test])
    metrics = lora_data.score(outputs, [t["answer"] for t in test])
    samples = [{"email": t["email"], "answer": t["answer"], "output": o,
                "fields": lora_data.score_one(o, t["answer"])["fields"]} for t, o in zip(test[:6], outputs[:6])]
    result = {"phase": phase, "metrics": metrics, "samples": samples, "seconds": round(time.perf_counter() - started, 1)}
    emit({"type": "eval", **result})
    return result


def batches(tokenizer: Any, train: list[dict], batch: int, steps: int, seed: int) -> list[list[dict[str, list[int]]]]:
    """Each example as token ids, with labels only on the answer (the prompt's labels are -100, so the loss is
    about writing the answer, not repeating the email). Shuffled, repeated as often as the steps need."""
    rows = []
    for t in train:
        p = tokenizer(prompt(tokenizer, t["email"]), add_special_tokens=False)["input_ids"]
        a = tokenizer(t["target"], add_special_tokens=False)["input_ids"] + [tokenizer.eos_token_id]
        rows.append({"input_ids": p + a, "labels": [-100] * len(p) + a})
    rng, order, out = random.Random(seed), [], []
    while len(order) < steps * batch:
        chunk = list(range(len(rows)))
        rng.shuffle(chunk)
        order += chunk
    for s in range(steps):
        out.append([rows[i] for i in order[s * batch:(s + 1) * batch]])
    return out


def collate(torch: Any, tokenizer: Any, rows: list[dict[str, list[int]]], device: str) -> dict[str, Any]:
    width = max(len(r["input_ids"]) for r in rows)
    pad = tokenizer.pad_token_id
    ids = [r["input_ids"] + [pad] * (width - len(r["input_ids"])) for r in rows]
    labels = [r["labels"] + [-100] * (width - len(r["labels"])) for r in rows]
    mask = [[1] * len(r["input_ids"]) + [0] * (width - len(r["input_ids"])) for r in rows]
    return {"input_ids": torch.tensor(ids, device=device), "labels": torch.tensor(labels, device=device),
            "attention_mask": torch.tensor(mask, device=device)}


def folder_bytes(path: Path, name: str) -> int:
    f = path / name
    return f.stat().st_size if f.exists() else 0


def train(job: dict[str, Any]) -> None:
    started = time.perf_counter()
    torch, model, tokenizer, device, base_path = load(job)
    from peft import LoraConfig, get_peft_model

    seed = int(job.get("seed", 0))
    torch.manual_seed(seed)
    train_set, test_set = lora_data.dataset()
    test = test_set[: int(job.get("eval_n", 40))]
    emit({"type": "setup", "device": device, "dtype": str(model.dtype).replace("torch.", ""),
          "train_examples": len(train_set), "test_examples": len(test), "model_id": job.get("model_id")})

    cache = Path(job["models_dir"]) / f"{base_path.name}.before-{len(test)}.json"
    if cache.exists():
        before = json.loads(cache.read_text())
        emit({"type": "eval", **before, "cached": True})
    else:
        before = evaluate(torch, model, tokenizer, device, test, "before")
        cache.write_text(json.dumps(before))

    total = sum(p.numel() for p in model.parameters())
    config = LoraConfig(r=int(job.get("r", 16)), lora_alpha=int(job.get("alpha", 32)),
                        lora_dropout=float(job.get("dropout", 0.05)),
                        target_modules=job.get("targets") or lora_data.TARGETS, task_type="CAUSAL_LM")
    if job.get("quantize") == "4bit":
        from peft import prepare_model_for_kbit_training

        model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, config)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    emit({"type": "params", "trainable": trainable, "total": total, "share": round(trainable / total, 6)})

    steps, batch, lr = int(job.get("steps", 150)), int(job.get("batch", 8)), float(job.get("lr", 5e-4))
    plan = batches(tokenizer, train_set, batch, steps, seed)
    optimiser = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=0.0)
    warmup = max(1, steps // 10)
    schedule = torch.optim.lr_scheduler.LambdaLR(
        optimiser, lambda s: min(1.0, (s + 1) / warmup) * max(0.05, 1 - max(0, s - warmup) / max(1, steps - warmup)))
    progress(f"Training: {steps} steps of {batch} emails")
    model.train()
    train_started, last_loss = time.perf_counter(), None
    for step, rows in enumerate(plan, 1):
        out = model(**collate(torch, tokenizer, rows, device))
        out.loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimiser.step()
        schedule.step()
        optimiser.zero_grad(set_to_none=True)
        last_loss = round(out.loss.item(), 4)
        emit({"type": "step", "step": step, "steps": steps, "loss": last_loss,
              "lr": round(schedule.get_last_lr()[0], 7), "elapsed_s": round(time.perf_counter() - train_started, 1),
              "memory_mb": memory_mb(torch, device)})
    train_s = round(time.perf_counter() - train_started, 1)
    model.eval()

    out_dir = Path(job["out_dir"])
    model.save_pretrained(out_dir)
    adapter_bytes = folder_bytes(out_dir, "adapter_model.safetensors")
    base_bytes = folder_bytes(base_path, "model.safetensors")
    after = evaluate(torch, model, tokenizer, device, test, "after")

    # Merging folds B x A into W, so the adapter disappears and the model runs at its old speed. Check it is the same.
    merge: dict[str, Any] = {}
    if job.get("quantize") != "4bit":
        progress("Checking that merging the adapter into the weights gives the same answers")
        enc = tokenizer([prompt(tokenizer, test[0]["email"]) + test[0]["target"]], return_tensors="pt",
                        add_special_tokens=False).to(device)
        with torch.no_grad():
            with_adapter = model(**enc).logits.float()
            merged = model.merge_and_unload()
            folded = merged(**enc).logits.float()
        merge = {"max_logit_difference": float((with_adapter - folded).abs().max()),
                 "tokens_compared": int(enc["input_ids"].shape[1])}
        emit({"type": "merge", **merge})

    result = {"type": "result", "model_id": job.get("model_id"), "device": device,
              "config": {"r": config.r, "alpha": config.lora_alpha, "dropout": config.lora_dropout,
                         "targets": sorted(config.target_modules), "lr": lr, "steps": steps, "batch": batch,
                         "seed": seed, "quantize": job.get("quantize", "none")},
              "params": {"trainable": trainable, "total": total, "share": round(trainable / total, 6)},
              "sizes": {"adapter_bytes": adapter_bytes, "base_bytes": base_bytes},
              "before": before, "after": after, "merge": merge, "train_s": train_s,
              "total_s": round(time.perf_counter() - started, 1), "memory_mb": memory_mb(torch, device),
              "final_loss": last_loss}
    (out_dir / "result.json").write_text(json.dumps(result))
    emit(result)


def try_it(job: dict[str, Any]) -> None:
    torch, model, tokenizer, device, _ = load(job)
    email = job["email"]
    base = generate(torch, model, tokenizer, device, [email])[0]
    adapted = None
    if job.get("adapter_dir"):
        from peft import PeftModel

        progress("Adding the adapter")
        model = PeftModel.from_pretrained(model, job["adapter_dir"]).to(device)
        model.eval()
        adapted = generate(torch, model, tokenizer, device, [email])[0]
    emit({"type": "result", "base": base, "adapter": adapted, "base_json": lora_data.parse(base) is not None,
          "adapter_json": adapted is not None and lora_data.parse(adapted) is not None})


def main() -> None:
    job = json.loads(sys.stdin.read() or "{}")
    try:
        {"train": train, "try": try_it}[job.get("action", "train")](job)
    except Exception as exc:  # the page shows this
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
