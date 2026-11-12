"""Tabular foundation models: TabPFN against gradient boosting on a CSV, with an agent that suggests what to predict
and explains the results.

TabPFN was pre-trained on millions of synthetic tables; it reads the training rows as context and predicts the test
rows in one forward pass, with no training for each dataset. It needs PyTorch, so it runs in its own environment
(examples/tabular/.venv) as a subprocess, as the coding agent runs its SDK twin.

The model reads and explains; code computes. The model sees only a summary of the columns (names, types, a few
values), proposes the target, and code checks it names a real column. Every metric comes from the script, and the
explanation is checked for numbers that are not in the results (one retry, then the numbers are not shown).
"""
from __future__ import annotations

import csv
import io
import json
import math
import random
import re
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, ROOT, text_of
from .runs import Run, RunStreamer
from .spend import SpendTracker

MAX_UPLOAD_BYTES = 5 * 2**20
MAX_ROWS = 20_000  # rows read from an upload; TabPFN itself uses at most 3,000 of them as context
MAX_COLUMNS = 101  # 100 features and the target
RUN_TIMEOUT_S = 600
SETUP = "cd examples/tabular && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"

TARGET_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["target", "task", "why"],
    "properties": {"target": {"type": "string"}, "task": {"type": "string", "enum": ["classification", "regression"]},
                   "why": {"type": "string"}},
}

TARGET_SYSTEM = """You help someone try a tabular prediction model on their table. You see a summary of each column
(its name, type, how many different values, a few examples), never the whole file. Choose the column it would be most
useful to predict from the others, and whether that is classification (a category, or a number with only a few values
such as 0/1) or regression (a quantity). Prefer an outcome (churned, price, defaulted) over an identifier or a date.
"why" is one plain sentence. Answer as JSON."""

EXPLAIN_SYSTEM = """You explain the results of a comparison between two models on one table: TabPFN (a pre-trained
tabular foundation model that predicts by in-context learning, with no training on this table) and gradient boosting
(trees trained on this table). You get the results as JSON. In four to six plain sentences for someone new to machine
learning: which did better and by how much, what the main metric means, how long each took, and one sensible caution
(a single split on a small test set can vary). Use only numbers that appear in the results, written the same way
(0.8125 may be written as 0.81 or 81%). Do not invent any other number. No headings, no lists."""


# ----------------------------------------------------------------------------------------------- sample datasets

def _churn(rng: random.Random) -> tuple[list[str], list[list[Any]]]:
    plans = ["basic", "standard", "premium"]
    rows = []
    for i in range(900):
        tenure = rng.randint(1, 72)
        plan = rng.choice(plans)
        monthly = round({"basic": 12, "standard": 25, "premium": 45}[plan] + rng.gauss(0, 4), 2)
        calls = max(0, int(rng.gauss(1.5, 1.5)))
        late = rng.random() < 0.15
        risk = -2.0 + 0.04 * monthly - 0.05 * tenure + 0.45 * calls + (1.2 if late else 0) + rng.gauss(0, 0.6)
        rows.append([f"C{i:04d}", tenure, plan, monthly, calls, "yes" if late else "no",
                     "yes" if risk > 0 else "no"])
    return ["customer_id", "tenure_months", "plan", "monthly_fee", "support_calls", "late_payment", "churned"], rows


def _houses(rng: random.Random) -> tuple[list[str], list[list[Any]]]:
    areas = {"centre": 1.35, "suburb": 1.0, "village": 0.85}
    rows = []
    for _ in range(700):
        area = rng.choice(list(areas))
        beds = rng.randint(1, 5)
        size = round(35 + beds * 22 + rng.gauss(0, 12))
        age = rng.randint(0, 120)
        garden = rng.random() < 0.6
        price = (size * 2600 * areas[area] + (18000 if garden else 0) - age * 300 + rng.gauss(0, 15000))
        rows.append([area, beds, size, age, "yes" if garden else "no", round(max(price, 60000), -2)])
    return ["area", "bedrooms", "floor_area_m2", "age_years", "garden", "price_gbp"], rows


def _loans(rng: random.Random) -> tuple[list[str], list[list[Any]]]:
    purposes = ["car", "home improvement", "debt consolidation", "holiday"]
    rows = []
    for _ in range(1200):
        income = round(max(12000, rng.gauss(36000, 12000)), -2)
        amount = round(rng.uniform(1000, 25000), -2)
        years = rng.randint(0, 30)
        purpose = rng.choice(purposes)
        missed = max(0, int(rng.gauss(0.4, 0.9)))
        z = (-2.5 + 2.2 * amount / income * 3 - 0.04 * years + 0.7 * missed
             + (0.6 if purpose == "debt consolidation" else 0) + rng.gauss(0, 0.7))
        rows.append([income, amount, years, purpose, missed, "yes" if z > 0 else "no"])
    return ["annual_income_gbp", "loan_amount_gbp", "years_employed", "purpose", "missed_payments_last_year",
            "defaulted"], rows


SAMPLES: dict[str, dict[str, Any]] = {
    "churn": {"label": "Customer churn (900 rows)", "make": _churn,
              "about": "Invented subscription customers: who left. Classification."},
    "houses": {"label": "House prices (700 rows)", "make": _houses,
               "about": "Invented homes: the sale price. Regression."},
    "loans": {"label": "Loan defaults (1,200 rows)", "make": _loans,
              "about": "Invented loans: which were not repaid. Classification."},
}


# ----------------------------------------------------------------------------------------------- reading a table

def parse_csv(raw: bytes) -> tuple[list[str], list[list[str]]]:
    """The header and rows of a CSV, with its size, row and column caps checked."""
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ApiError(400, "invalid_request", f"Upload a CSV under {MAX_UPLOAD_BYTES // 2**20} MB.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ApiError(400, "invalid_request", "The file must be a UTF-8 CSV.") from None
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    header = next(reader, None)
    if not header or len(header) < 2:
        raise ApiError(400, "invalid_request", "The CSV needs a header row and at least two columns.")
    header = [h.strip() for h in header]
    if len(set(header)) != len(header) or any(not h for h in header):
        raise ApiError(400, "invalid_request", "Every column needs a name, and the names must be different.")
    if len(header) > MAX_COLUMNS:
        raise ApiError(400, "invalid_request", f"TabPFN here takes at most {MAX_COLUMNS - 1} columns plus the target.")
    rows = []
    for row in reader:
        if not any(cell.strip() for cell in row):
            continue
        if len(row) != len(header):
            raise ApiError(400, "invalid_request", f"Row {len(rows) + 2} has {len(row)} values, not {len(header)}.")
        rows.append(row)
        if len(rows) > MAX_ROWS:
            raise ApiError(400, "invalid_request", f"Upload at most {MAX_ROWS:,} rows.")
    if len(rows) < 20:
        raise ApiError(400, "invalid_request", "The CSV needs at least 20 rows.")
    return header, rows


def _number(cell: str) -> float | None:
    try:
        v = float(cell.replace(",", "")) if cell.strip() else None
    except ValueError:
        return None
    return v if v is not None and math.isfinite(v) else None


def summarise(header: list[str], rows: list[list[str]]) -> list[dict[str, Any]]:
    """Each column's type and a few values: what the model is shown instead of the file."""
    out = []
    for i, name in enumerate(header):
        cells = [r[i].strip() for r in rows]
        filled = [c for c in cells if c]
        numbers = [_number(c) for c in filled]
        numeric = bool(filled) and all(n is not None for n in numbers)
        distinct = len(set(filled))
        kind = "number" if numeric else "text"
        if numeric and distinct <= 10:
            kind = "number (few values)"
        col: dict[str, Any] = {"name": name, "type": kind, "distinct": distinct, "missing": len(cells) - len(filled),
                               "examples": list(dict.fromkeys(filled))[:5]}
        if numeric:
            vals = [n for n in numbers if n is not None]
            col.update({"min": round(min(vals), 4), "max": round(max(vals), 4)})
        if distinct == len(filled) and not numeric:
            col["note"] = "every value different (an identifier?)"
        out.append(col)
    return out


def check_target(choice: dict[str, Any], columns: list[dict[str, Any]]) -> list[str]:
    """Why a proposed target cannot be used, or nothing when it can."""
    found = []
    col = next((c for c in columns if c["name"] == choice.get("target")), None)
    if col is None:
        found.append(f"target {choice.get('target')!r} is not one of the columns: {', '.join(c['name'] for c in columns)}")
        return found
    if choice.get("task") == "regression" and not col["type"].startswith("number"):
        found.append(f"{col['name']} is text, so it cannot be a regression target")
    if choice.get("task") == "classification" and col["distinct"] > 10:
        found.append(f"{col['name']} has {col['distinct']} different values; TabPFN classifies at most 10 classes")
    if col["distinct"] < 2:
        found.append(f"{col['name']} has only one value")
    return found


# ----------------------------------------------------------------------------------------------- the number check

NUMBER = re.compile(r"(?<![\w.])-?\d+(?:[.,]\d+)*(?:\.\d+)?%?")


def _known_numbers(result: dict[str, Any]) -> set[float]:
    """Every number in the results, and the forms an explanation may fairly write it in."""
    found: set[float] = set()

    def walk(v: Any) -> None:
        if isinstance(v, bool):
            return
        if isinstance(v, (int, float)):
            x = float(v)
            found.update({x, round(x, 1), round(x, 2), round(x, 3), round(x * 100, 1), round(x * 100), round(x)})
        elif isinstance(v, dict):
            for item in v.values():
                walk(item)
        elif isinstance(v, list):
            for item in v:
                walk(item)

    walk(result)
    return found


def unknown_numbers(text: str, result: dict[str, Any]) -> list[str]:
    """Numbers in the explanation that are not in the results (after fair rounding). Small counting words like 1 or 2
    and years are allowed, since sentences need them."""
    known = _known_numbers(result)
    # differences between the two models are fair game too ("0.03 better")
    flat = sorted(known)
    bad = []
    for match in NUMBER.findall(text):
        token = match.rstrip("%").replace(",", "")
        try:
            value = float(token)
        except ValueError:
            continue
        if abs(value) <= 10 and value == int(value):
            continue
        if any(abs(value - k) <= 0.005 * max(1, abs(k)) for k in flat):
            continue
        if any(abs(value - abs(a - b)) < 0.0051 for a in flat for b in flat if a != b and abs(a) < 1e6):
            continue
        bad.append(match)
    return bad


# ----------------------------------------------------------------------------------------------- the service

class TabularService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, root: Path, streamer: RunStreamer | None = None,
                 venv_python: Path | None = None, script: Path | None = None,
                 runner: Callable[[list[str], str, Callable[[dict], None]], int] | None = None):
        self.claude, self.spend, self.root, self.streamer = claude, spend, root, streamer
        folder = ROOT / "examples" / "tabular"
        self.python = venv_python or folder / ".venv" / "bin" / "python"
        self.script = script or folder / "run_tabular.py"
        self.runner = runner or self._subprocess
        self._lock = threading.Lock()

    # ----- tables

    def info(self) -> dict[str, Any]:
        return {"samples": [{"id": k, "label": v["label"], "about": v["about"]} for k, v in SAMPLES.items()],
                "ready": self.python.exists(), "setup": SETUP, "model": CLAUDE_MODEL,
                "limits": {"upload_mb": MAX_UPLOAD_BYTES // 2**20, "rows": MAX_ROWS, "train_rows": 3000,
                           "columns": MAX_COLUMNS - 1}}

    def _save(self, header: list[str], rows: list[list[Any]], name: str) -> dict[str, Any]:
        table_id = uuid.uuid4().hex[:16]
        folder = self.root / table_id
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / "data.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(header)
            w.writerows(rows)
        str_rows = [[str(c) for c in r] for r in rows]
        columns = summarise(header, str_rows)
        (folder / "meta.json").write_text(json.dumps({"name": name, "columns": columns, "rows": len(rows)}))
        return {"table_id": table_id, "name": name, "rows": len(rows), "columns": columns,
                "preview": [header] + str_rows[:8]}

    def upload(self, raw: bytes, name: str) -> dict[str, Any]:
        header, rows = parse_csv(raw)
        return self._save(header, rows, re.sub(r"[^\w .-]", "", name)[:80] or "upload.csv")

    def sample(self, sample_id: str) -> dict[str, Any]:
        found = SAMPLES.get(sample_id)
        if found is None:
            raise ApiError(404, "not_found", f"Choose one of: {', '.join(SAMPLES)}.")
        header, rows = found["make"](random.Random(7))  # the same table every time
        return self._save(header, rows, found["label"])

    def _meta(self, table_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"[0-9a-f]{16}", table_id or ""):
            raise ApiError(404, "not_found", "That table has gone. Upload it again.")
        path = self.root / table_id / "meta.json"
        if not path.exists():
            raise ApiError(404, "not_found", "That table has gone. Upload it again.")
        return json.loads(path.read_text())

    # ----- the model's two jobs

    def _ask(self, model: str, system: str, text: str, schema: dict | None, max_tokens: int) -> tuple[str, float]:
        params: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system,
                                  "messages": [{"role": "user", "content": text}]}
        if schema:
            params["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
        try:
            response = self.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        return text_of(response), self.spend.charge(response, model) or 0.0

    def suggest(self, table_id: str, model: str | None) -> dict[str, Any]:
        """The model proposes the target from the column summary; code checks it (one retry with the problems)."""
        model = model or CLAUDE_MODEL
        columns = self._meta(table_id)["columns"]
        prompt = "Columns:\n" + json.dumps(columns, ensure_ascii=False)
        cost, tries = 0.0, []
        for attempt in range(2):
            text, spent = self._ask(model, TARGET_SYSTEM, prompt, TARGET_SCHEMA, 400)
            cost += spent
            try:
                choice = json.loads(text)
                found = check_target(choice, columns)
            except (json.JSONDecodeError, AttributeError):
                choice, found = {}, ["the answer was not the JSON asked for"]
            tries.append({"attempt": attempt + 1, "problems": found})
            if not found:
                return {**choice, "tries": tries, "cost_usd": round(cost, 6), "model": model}
            prompt += "\n\nYour choice cannot be used: " + "; ".join(found) + ". Choose again."
        raise ApiError(502, "unusable", "The model could not suggest a usable target: "
                                        + "; ".join(tries[-1]["problems"]) + ". Choose one yourself.")

    def explain(self, result: dict[str, Any], model: str) -> tuple[str, float, list[dict]]:
        """A plain explanation of the results, checked for numbers that are not in them."""
        facts = json.dumps({k: result[k] for k in ("task", "target", "rows", "train_rows", "test_rows", "columns")}
                           | {"results": {m: {"metrics": {k: v for k, v in r["metrics"].items() if k != "confusion"},
                                                  "fit_s": r["fit_s"], "predict_s": r["predict_s"]}
                                              for m, r in result["results"].items()}})
        prompt = f"<results>{facts}</results>"
        cost, tries = 0.0, []
        for attempt in range(2):
            text, spent = self._ask(model, EXPLAIN_SYSTEM, prompt, None, 700)
            cost += spent
            bad = unknown_numbers(text, json.loads(facts))
            tries.append({"attempt": attempt + 1, "problems": [f"{b} is not in the results" for b in bad]})
            if not bad:
                return text.strip(), cost, tries
            prompt += f"\n\nYour explanation used numbers that are not in the results: {', '.join(bad)}. Write it again."
        return ("The model's explanation kept using numbers that are not in the results, so it is not shown. The "
                "table above has every figure."), cost, tries

    # ----- running the comparison

    def _subprocess(self, argv: list[str], job: str, on_line: Callable[[dict], None]) -> int:
        proc = subprocess.Popen(argv, cwd=self.script.parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, bufsize=1)
        timer = threading.Timer(RUN_TIMEOUT_S, proc.kill)
        timer.start()
        try:
            assert proc.stdin and proc.stdout
            proc.stdin.write(job)
            proc.stdin.close()
            for line in proc.stdout:
                try:
                    on_line(json.loads(line))
                except json.JSONDecodeError:
                    continue
            return proc.wait()
        finally:
            timer.cancel()

    def run(self, table_id: str, target: str, task: str, model: str | None, test_size: float = 0.25,
            seed: int = 0) -> Iterator[str]:
        """Both models on the table, streamed: progress, the results, then the model's explanation."""
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        meta = self._meta(table_id)
        problems = check_target({"target": target, "task": task}, meta["columns"])
        if problems:
            raise ApiError(400, "invalid_request", "; ".join(problems))
        if not self.python.exists():
            raise ApiError(503, "not_installed", f"TabPFN is not installed. From the repo root run: {SETUP}")
        model = model or CLAUDE_MODEL
        run = Run()

        def work() -> None:
            run.publish({"type": "progress", "step": "Starting TabPFN's environment (the first run downloads its "
                                                     "weights, about 75 MB)"})
            got: dict[str, Any] = {}

            def on_line(event: dict) -> None:
                if event.get("type") == "progress":
                    run.publish(event)
                elif event.get("type") in ("result", "error"):
                    got.update(event)

            job = json.dumps({"csv": str(self.root / table_id / "data.csv"), "target": target, "task": task,
                              "test_size": test_size, "seed": seed})
            try:
                code = self.runner([str(self.python), str(self.script)], job, on_line)
            except OSError as exc:
                run.publish({"type": "error", "message": f"Could not start TabPFN's environment: {exc}"})
                return
            if got.get("type") != "result":
                run.publish({"type": "error", "message": got.get("message")
                             or f"The comparison stopped (exit code {code}). See the backend log."})
                return
            run.publish({"type": "result", "result": got})
            run.publish({"type": "progress", "step": "Explaining the results"})
            try:
                text, cost, tries = self.explain(got, model)
            except ApiError as exc:
                run.publish({"type": "error", "message": f"The results are above; the explanation failed: {exc.message}"})
                return
            run.publish({"type": "done", "explanation": text, "tries": tries, "cost_usd": round(cost, 6),
                         "model": model})

        return self.streamer.lines(run, work)
