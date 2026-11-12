"""Tabular foundation models: the CSV checks, the target check, the number check on the explanation, and a whole run
through the API with a fake subprocess and a scripted model. No network, no PyTorch, no cost."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services import tabular
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient, text
from backend.tests.test_api import LAB

RESULT = {"type": "result", "task": "classification", "target": "churned", "rows": 900, "train_rows": 675,
          "test_rows": 225, "columns": 5, "dropped_columns": ["customer_id"],
          "results": {"tabpfn": {"metrics": {"accuracy": 0.9289, "balanced_accuracy": 0.82, "roc_auc": 0.9604,
                                             "confusion": {"labels": ["no", "yes"], "matrix": [[180, 5], [11, 29]]}},
                                 "fit_s": 0.087, "predict_s": 3.724, "sample": []},
                      "gradient_boosting": {"metrics": {"accuracy": 0.9111, "balanced_accuracy": 0.74, "roc_auc": 0.9405,
                                                        "confusion": {"labels": ["no", "yes"], "matrix": [[178, 7], [13, 27]]}},
                                            "fit_s": 1.636, "predict_s": 0.024, "sample": []}},
          "versions": {"tabpfn": "9.2.0", "weights": "TabPFN v2"}}


def csv_bytes(rows: int = 30, cols: int = 3) -> bytes:
    header = ",".join(f"c{i}" for i in range(cols - 1)) + ",label"
    body = "\n".join(",".join(str(r * (i + 1)) for i in range(cols - 1)) + ("," + ("yes" if r % 2 else "no"))
                     for r in range(rows))
    return f"{header}\n{body}\n".encode()


def test_csv_checks_and_column_types() -> None:
    header, rows = tabular.parse_csv(csv_bytes())
    cols = tabular.summarise(header, rows)
    assert [c["type"] for c in cols] == ["number", "number", "text"] and cols[2]["distinct"] == 2
    for bad, why in ((csv_bytes(rows=5), "at least 20 rows"), (b"a,a\n" + b"1,2\n" * 30, "names must be different"),
                     (csv_bytes(cols=tabular.MAX_COLUMNS + 1), "at most"), (b"a,b\n1,2\n1\n" * 12, "values, not 2"),
                     (b"x" * (tabular.MAX_UPLOAD_BYTES + 1), "under"), ("a,b\n".encode("utf-16"), "UTF-8")):
        with pytest.raises(ApiError, match=why):
            tabular.parse_csv(bad)
    semi = tabular.parse_csv(b"a;b\n" + b"1;x\n" * 25)  # a semicolon file, as Excel saves in some countries
    assert semi[0] == ["a", "b"]


def test_a_target_must_be_a_real_usable_column() -> None:
    cols = tabular.summarise(*tabular.parse_csv(csv_bytes()))
    assert tabular.check_target({"target": "label", "task": "classification"}, cols) == []
    assert "not one of the columns" in tabular.check_target({"target": "price", "task": "regression"}, cols)[0]
    assert "is text" in tabular.check_target({"target": "label", "task": "regression"}, cols)[0]
    assert "at most 10 classes" in tabular.check_target({"target": "c0", "task": "classification"}, cols)[0]


def test_numbers_not_in_the_results_are_caught() -> None:
    fine = ("TabPFN reached an accuracy of 0.93 (93%), against 0.91 for gradient boosting, a gap of 0.0178. "
            "It predicted in 3.7 seconds on 225 test rows; the trees took 1.6 seconds to fit. Use 2 or 3 splits.")
    assert tabular.unknown_numbers(fine, RESULT) == []
    assert tabular.unknown_numbers("TabPFN scored 0.97 and was 40% faster.", RESULT) == ["0.97", "40%"]


def test_a_whole_run_through_the_api(tmp_path: Path) -> None:
    def fake_runner(argv: list[str], job: str, on_line) -> int:
        sent = json.loads(job)
        assert argv[1].endswith("run_tabular.py") and sent["target"] == "churned" and Path(sent["csv"]).exists()
        on_line({"type": "progress", "step": "TabPFN: fitting"})
        on_line(RESULT)
        return 0

    python = tmp_path / "python"
    python.write_text("")
    suggestion = {"target": "churned", "task": "classification", "why": "It is the outcome."}
    fake = ScriptedClient([[text(json.dumps({**suggestion, "target": "customer"}))], [text(json.dumps(suggestion))],
                           [text("TabPFN scored 0.99, the best ever.")],
                           [text("TabPFN reached 0.93 accuracy against 0.91, and predicted in 3.7 seconds.")]])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=fake)
    client = TestClient(app, base_url="http://localhost:8000")
    info = client.get("/api/tabular/info", headers=LAB).json()
    assert [s["id"] for s in info["samples"]] == ["churn", "houses", "loans"]

    table = client.post("/api/tabular/samples/churn", headers=LAB).json()
    again = client.post("/api/tabular/samples/churn", headers=LAB).json()
    assert table["rows"] == 900 and table["preview"][1] == again["preview"][1]  # the same invented table each time
    assert next(c for c in table["columns"] if c["name"] == "customer_id")["note"].startswith("every value different")

    s = client.post("/api/tabular/suggest", headers=LAB, json={"table_id": table["table_id"],
                                                               "model": "claude-haiku-5-5"}).json()
    assert s["target"] == "churned" and [t["attempt"] for t in s["tries"]] == [1, 2]
    assert "not one of the columns" in s["tries"][0]["problems"][0]
    shown = fake.calls[0][1]["messages"][0]["content"]
    assert "C0000" in shown and "C0123" not in shown  # a summary with a few values, never the whole file

    # Not installed: the route says what to run.
    svc = app.state.container.tabular
    svc.python = tmp_path / "no-venv" / "python"
    r = client.post("/api/tabular/run", headers=LAB, json={"table_id": table["table_id"], "target": "churned",
                                                          "task": "classification"})
    assert r.status_code == 503 and "python3.12 -m venv" in r.json()["error"]["message"]

    svc.python, svc.runner = python, fake_runner
    lines = client.post("/api/tabular/run", headers=LAB, json={"table_id": table["table_id"], "target": "churned",
                                                              "task": "classification", "model": "claude-haiku-5-5"})
    events = [json.loads(line) for line in lines.text.splitlines() if line.strip()]
    kinds = [e["type"] for e in events]
    assert "result" in kinds and kinds[-1] == "done"
    done = events[-1]
    assert done["explanation"].startswith("TabPFN reached 0.93") and done["tries"][0]["problems"] == ["0.99 is not in the results"]
    assert client.post("/api/tabular/run", headers=LAB, json={"table_id": table["table_id"], "target": "nope",
                                                             "task": "classification"}).status_code == 400
    assert client.post("/api/tabular/samples/nope", headers=LAB).status_code == 404
    upload = client.post("/api/tabular/tables", headers=LAB, files={"file": ("mine.csv", csv_bytes(), "text/csv")}).json()
    assert upload["rows"] == 30 and [c["name"] for c in upload["columns"]] == ["c0", "c1", "label"]
