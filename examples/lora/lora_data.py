"""The LoRA lab's task, its scoring and its memory arithmetic, in plain Python with no PyTorch, so the backend (and its
tests) can use them as well as run_lora.py.

The task: read an invented customer email and answer with one JSON object in a fixed shape. A small instruct model
asked nicely gets the shape wrong often; a few minutes of LoRA training on a few hundred examples teaches it. Code
writes the emails and the right answers, so every score is checked by code, not by a model.
"""
from __future__ import annotations

import json
import random
import re
from typing import Any

FIELDS = ["customer", "order_id", "product", "issue", "wants"]
ISSUES = ["damaged", "late", "wrong_item", "missing_part"]
WANTS = ["refund", "replacement", "update"]

SYSTEM = ("Extract the order details from the customer's email. Answer with one JSON object and nothing else, with "
          'exactly these keys: "customer" (their name), "order_id", "product", "issue" (one of damaged, late, '
          'wrong_item, missing_part) and "wants" (one of refund, replacement, update).')

FIRST = ["Amira", "Ben", "Chloe", "Dev", "Ellie", "Femi", "Grace", "Hamza", "Isla", "Jack", "Kiran", "Leah", "Mo",
         "Niamh", "Olu", "Priya", "Rory", "Sana", "Tom", "Uma", "Vik", "Wren", "Yusuf", "Zara"]
LAST = ["Ahmed", "Brown", "Clarke", "Davies", "Evans", "Fraser", "Green", "Hughes", "Iqbal", "Jones", "Khan", "Lewis",
        "Murphy", "Nolan", "Owen", "Patel", "Quinn", "Reid", "Singh", "Taylor", "Walsh", "Young"]
PRODUCTS = ["kettle", "desk lamp", "rucksack", "coffee grinder", "bike light", "yoga mat", "toaster", "headphones",
            "garden hose", "phone case", "air fryer", "office chair", "rain jacket", "blender", "water bottle"]

ISSUE_WORDS = {
    "damaged": ["arrived cracked", "came broken", "was smashed in the box", "has a big dent in it", "arrived scratched",
                "stopped working after one use"],
    "late": ["still hasn't arrived", "is over a week late", "was due on Monday and never came",
             "is showing as delayed again", "has not turned up yet"],
    "wrong_item": ["turned out to be the wrong colour", "is not what I ordered", "came in the wrong size",
                   "was someone else's order", "is a different model from the one I paid for"],
    "missing_part": ["came without the charging cable", "is missing the lid", "had no screws in the box",
                     "arrived without the instructions and the power lead", "is missing one of the parts"],
}
WANTS_WORDS = {
    "refund": ["I'd like my money back.", "Please refund me.", "Can I have a refund, please?",
               "I want a full refund."],
    "replacement": ["Please send a new one.", "Could you send a replacement?", "I'd like it replaced.",
                    "Can you swap it for a working one?"],
    "update": ["Can you tell me what's happening?", "Please let me know where it is.",
               "Could I get an update?", "When will this be sorted?"],
}
OPENINGS = ["Hi,", "Hello,", "Dear team,", "Hi there,", "Good morning,", "To whom it may concern,"]
SIGN_OFFS = ["Thanks,", "Regards,", "Best wishes,", "Cheers,", "Many thanks,", "Kind regards,"]
TEMPLATES = [
    "{open}\n\nMy order {order} for a {product} {problem}. {wants}\n\n{sign}\n{name}",
    "{open}\n\nI ordered a {product} (order {order}) and it {problem}. {wants}\n\n{sign}\n{name}",
    "{open}\n\nRe order number {order}: the {product} {problem}. {wants} This is the second time I've written.\n\n"
    "{sign}\n{name}",
    "{open}\n\nNot happy. The {product} I bought {problem}. Order ref {order}. {wants}\n\n{sign}\n{name}",
    "{open}\n\n{wants} The {product} from order {order} {problem}.\n\n{sign}\n{name}",
]


def example(rng: random.Random) -> dict[str, Any]:
    """One invented email and the JSON a model should answer with."""
    name = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    order = f"NW-{rng.randint(10000, 99999)}"
    product = rng.choice(PRODUCTS)
    issue = rng.choice(ISSUES)
    # a late parcel is never asked to be replaced; nothing else is ruled out
    wants = rng.choice(["refund", "update"] if issue == "late" else WANTS)
    email = rng.choice(TEMPLATES).format(open=rng.choice(OPENINGS), order=order, product=product,
                                         problem=rng.choice(ISSUE_WORDS[issue]), wants=rng.choice(WANTS_WORDS[wants]),
                                         sign=rng.choice(SIGN_OFFS), name=name)
    answer = {"customer": name, "order_id": order, "product": product, "issue": issue, "wants": wants}
    return {"email": email, "answer": answer, "target": json.dumps(answer)}


def dataset(n: int = 400, test: int = 60, seed: int = 7) -> tuple[list[dict], list[dict]]:
    """The same train and test sets every time: n examples, the last `test` of them held out."""
    rng = random.Random(seed)
    rows = [example(rng) for _ in range(n)]
    return rows[:-test], rows[-test:]


# ----------------------------------------------------------------------------------------------- scoring

def parse(output: str) -> dict[str, Any] | None:
    """The first JSON object in a model's output, or None. A code fence round it is allowed."""
    text = output.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start < 0:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def score_one(output: str, answer: dict[str, Any]) -> dict[str, Any]:
    """Whether one output is JSON, has exactly the right keys, and which fields match (ignoring case and spaces)."""
    got = parse(output)
    fields = {f: bool(got) and str(got.get(f, "")).strip().lower() == str(answer[f]).lower() for f in FIELDS}
    return {"json": got is not None, "keys": got is not None and sorted(got) == sorted(FIELDS), "fields": fields,
            "all": all(fields.values()), "parsed": got}


def score(outputs: list[str], answers: list[dict[str, Any]]) -> dict[str, Any]:
    """Rates over a set: valid JSON, exactly the right keys, each field right, and every field right."""
    scored = [score_one(o, a) for o, a in zip(outputs, answers)]
    n = len(scored) or 1
    rate = lambda xs: round(sum(xs) / n, 4)  # noqa: E731
    return {"n": len(scored), "valid_json": rate(s["json"] for s in scored),
            "right_keys": rate(s["keys"] for s in scored),
            "fields": {f: rate(s["fields"][f] for s in scored) for f in FIELDS},
            "all_fields": rate(s["all"] for s in scored)}


# ----------------------------------------------------------------------------------------------- memory arithmetic

# The shapes LoRA needs: the hidden size, the layers, the MLP's inner size and the width of k and v (smaller than the
# hidden size when heads share keys and values). Published configs; total parameters as each model card states them.
ARCHITECTURES: dict[str, dict[str, Any]] = {
    "HuggingFaceTB/SmolLM2-135M-Instruct": {"label": "SmolLM2 135M", "params": 134_515_008, "hidden": 576,
                                            "layers": 30, "intermediate": 1536, "kv": 192},
    "HuggingFaceTB/SmolLM2-360M-Instruct": {"label": "SmolLM2 360M", "params": 361_821_120, "hidden": 960,
                                            "layers": 32, "intermediate": 2560, "kv": 320},
    "meta-llama/Llama-3.1-8B": {"label": "Llama 3.1 8B", "params": 8_030_261_248, "hidden": 4096, "layers": 32,
                                "intermediate": 14336, "kv": 1024},
    "meta-llama/Llama-3.1-70B": {"label": "Llama 3.1 70B", "params": 70_553_706_496, "hidden": 8192, "layers": 80,
                                 "intermediate": 28672, "kv": 1024},
}
TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def module_shape(arch: dict[str, Any], name: str) -> tuple[int, int]:
    """(inputs, outputs) of one projection in one layer."""
    h, kv, inner = arch["hidden"], arch["kv"], arch["intermediate"]
    return {"q_proj": (h, h), "k_proj": (h, kv), "v_proj": (h, kv), "o_proj": (h, h),
            "gate_proj": (h, inner), "up_proj": (h, inner), "down_proj": (inner, h)}[name]


def lora_params(arch: dict[str, Any], r: int, targets: list[str]) -> int:
    """LoRA adds A (r x inputs) and B (outputs x r) beside each targeted matrix: r x (inputs + outputs) numbers."""
    return arch["layers"] * sum(r * sum(module_shape(arch, t)) for t in targets)


GB = 1e9


def memory(arch: dict[str, Any], r: int = 16, targets: list[str] | None = None) -> dict[str, Any]:
    """Memory for the weights, gradients and optimiser state of each way to fine-tune, before activations (which
    grow with batch size and sequence length). AdamW keeps two fp32 numbers per trained parameter.

    full:  16 bytes per parameter (bf16 weights 2, bf16 gradients 2, fp32 master copy 4, Adam's two moments 8)
    lora:  2 bytes per frozen parameter (bf16), 16 per adapter parameter
    qlora: about 0.52 bytes per frozen parameter (4-bit NF4, 0.5, plus its scales, about 0.016 with double
           quantisation), 16 per adapter parameter
    """
    targets = targets or TARGETS
    p, a = arch["params"], lora_params(arch, r, targets)
    full, lora, qlora = 16 * p, 2 * p + 16 * a, 0.516 * p + 16 * a
    return {"label": arch["label"], "params": p, "adapter_params": a, "adapter_share": round(a / p, 6),
            "full_gb": round(full / GB, 2), "lora_gb": round(lora / GB, 2), "qlora_gb": round(qlora / GB, 2),
            "adapter_mb": round(a * 2 / 1e6, 1)}
