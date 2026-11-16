"""Fine-tuning with LoRA: the invented task, its scoring, the memory arithmetic, and the routes with a fake runner in
place of the training script, so no PyTorch and no GPU."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Callable

from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.main import create_app
from backend.app.services.lora import LoraService, data
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient
from backend.tests.test_api import LAB

CONFIG = {"model_id": "HuggingFaceTB/SmolLM2-135M-Instruct", "r": 8, "alpha": 16, "targets": ["q_proj", "v_proj"],
          "lr": 5e-4, "steps": 5}


def test_the_dataset_is_fixed_and_its_answers_are_in_the_emails() -> None:
    train, test = data.dataset()
    assert (len(train), len(test)) == (340, 60) and data.dataset()[1] == test  # the same every time
    for row in train + test:
        a = row["answer"]
        assert a["customer"] in row["email"] and a["order_id"] in row["email"] and a["product"] in row["email"]
        assert a["issue"] in data.ISSUES and a["wants"] in data.WANTS and json.loads(row["target"]) == a
    assert {r["answer"]["issue"] for r in train} == set(data.ISSUES)
    assert not {r["email"] for r in train} & {r["email"] for r in test}  # nothing held out was trained on


def test_outputs_are_scored_by_code() -> None:
    answer = {"customer": "Ben Jones", "order_id": "NW-12345", "product": "kettle", "issue": "late", "wants": "refund"}
    perfect = json.dumps(answer)
    fenced = "```json\n" + json.dumps({**answer, "customer": "ben jones "}) + "\n```"
    wrong = json.dumps({**answer, "issue": "damaged", "extra": 1})
    s = data.score([perfect, fenced, wrong, "Ben Jones\n\nBen Jones", "{not json"], [answer] * 5)
    assert s["n"] == 5 and s["valid_json"] == 0.6 and s["right_keys"] == 0.4 and s["all_fields"] == 0.4
    assert s["fields"]["issue"] == 0.4 and s["fields"]["customer"] == 0.6
    assert data.parse("Sure! {\"a\": 1} and more") == {"a": 1} and data.parse("[1, 2]") is None


def test_memory_arithmetic_matches_the_published_shapes() -> None:
    small = data.ARCHITECTURES["HuggingFaceTB/SmolLM2-135M-Instruct"]
    assert data.lora_params(small, 16, data.TARGETS) == 4_884_480  # what peft counted on a real run
    llama = data.memory(data.ARCHITECTURES["meta-llama/Llama-3.1-8B"], 16)
    assert llama["adapter_params"] == 41_943_040 and llama["adapter_share"] < 0.01
    assert llama["full_gb"] > llama["lora_gb"] > llama["qlora_gb"]
    assert abs(llama["full_gb"] - 16 * 8.03) < 0.1 and llama["qlora_gb"] < 5
    # rank and targets scale the adapter linearly
    assert data.lora_params(small, 8, ["q_proj"]) * 2 == data.lora_params(small, 16, ["q_proj"])


class FakeRunner:
    """Stands in for the training script: replays a few events and writes the files a real run would."""

    def __init__(self, fail: bool = False, hold: threading.Event | None = None) -> None:
        self.fail, self.hold, self.jobs = fail, hold, []

    def __call__(self, argv: list[str], job: str, on_line: Callable[[dict], None], cancelled: threading.Event,
                 timeout_s: float) -> int:
        j = json.loads(job)
        self.jobs.append(j)
        if self.hold:
            self.hold.wait(5)
            if cancelled.is_set():
                return -9
        if j["action"] == "try":
            on_line({"type": "result", "base": "Ben", "adapter": '{"customer": "Ben"}', "base_json": False,
                     "adapter_json": True})
            return 0
        if self.fail:
            on_line({"type": "error", "message": "RuntimeError: out of memory"})
            return 1
        metrics = lambda v: {"n": 40, "valid_json": v, "right_keys": v, "fields": {}, "all_fields": v}  # noqa: E731
        on_line({"type": "eval", "phase": "before", "metrics": metrics(0.1)})
        for step in (1, 2, 3):
            on_line({"type": "step", "step": step, "steps": 3, "loss": 1 / step})
        result = {"type": "result", "model_id": j["model_id"], "config": {"r": j["r"], "targets": j["targets"]},
                  "params": {"trainable": 10, "total": 1000, "share": 0.01}, "sizes": {}, "train_s": 1.0,
                  "before": {"metrics": metrics(0.1)}, "after": {"metrics": metrics(0.95)}}
        Path(j["out_dir"]).mkdir(parents=True, exist_ok=True)
        (Path(j["out_dir"]) / "result.json").write_text(json.dumps(result))
        on_line(result)
        return 0


def make(tmp_path: Path, runner: Any, installed: bool = True) -> tuple[TestClient, LoraService]:
    settings = Settings(port=8000, budget_usd=0.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=ScriptedClient([]))
    python = tmp_path / "python"
    if installed:
        python.write_text("")
    service = LoraService(tmp_path / "lora", RunStreamer(RunRegistry(), 0.05), venv_python=python, runner=runner)
    app.dependency_overrides[deps.lora] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), service


def events(response: Any) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_a_run_streams_saves_an_adapter_and_can_be_tried_and_deleted(tmp_path: Path) -> None:
    runner = FakeRunner()
    client, _ = make(tmp_path, runner)
    info = client.get("/api/lora/info", headers=LAB).json()
    assert info["ready"] and info["dataset"]["train"] == 340 and len(info["memory"]) == 4 and info["adapters"] == []

    r = client.post("/api/lora/train", headers=LAB, json=CONFIG)  # no budget left, and still allowed: it is free
    got = events(r)
    assert [e["type"] for e in got] == ["run", "progress", "eval", "step", "step", "step", "result", "done"]
    assert runner.jobs[0]["targets"] == ["q_proj", "v_proj"] and runner.jobs[0]["eval_n"] == 40
    adapter = got[-1]["adapter_id"]
    [saved] = client.get("/api/lora/info", headers=LAB).json()["adapters"]
    assert saved["id"] == adapter and saved["after"]["all_fields"] == 0.95

    tried = client.post("/api/lora/try", headers=LAB, json={"email": "My kettle came broken.", "adapter_id": adapter})
    assert tried.json()["adapter_json"] is True and runner.jobs[-1]["adapter_dir"].endswith(adapter)
    assert client.delete(f"/api/lora/adapters/{adapter}", headers=LAB).json() == {"deleted": adapter}
    assert client.post("/api/lora/try", headers=LAB, json={"email": "x" * 20, "adapter_id": adapter}).status_code == 404


def test_a_failed_run_keeps_nothing_and_bad_settings_are_refused(tmp_path: Path) -> None:
    client, service = make(tmp_path, FakeRunner(fail=True))
    got = events(client.post("/api/lora/train", headers=LAB, json=CONFIG))
    assert got[-1] == {"type": "error", "message": "RuntimeError: out of memory"}
    assert service.adapters() == [] and not service._busy.locked()
    assert client.post("/api/lora/train", headers=LAB, json={**CONFIG, "targets": ["lm_head"]}).status_code == 400
    assert client.post("/api/lora/train", headers=LAB, json={**CONFIG, "model_id": "gpt2"}).status_code == 400
    assert client.post("/api/lora/train", headers=LAB, json={**CONFIG, "steps": 5000}).status_code in (400, 422)
    assert client.post("/api/lora/train", json=CONFIG).status_code in (400, 403)  # the lab-page guard


def test_one_run_at_a_time_and_cancel_stops_it(tmp_path: Path) -> None:
    hold = threading.Event()
    client, service = make(tmp_path, FakeRunner(hold=hold))
    first: dict[str, Any] = {}
    t = threading.Thread(target=lambda: first.update(r=client.post("/api/lora/train", headers=LAB, json=CONFIG)))
    t.start()
    for _ in range(100):
        if service._busy.locked():
            break
        threading.Event().wait(0.02)
    second = client.post("/api/lora/train", headers=LAB, json=CONFIG)
    assert second.status_code == 409 and "already" in second.json()["error"]["message"]
    assert client.post("/api/lora/cancel", headers=LAB).json() == {"cancelled": True}
    hold.set()
    t.join(5)
    assert events(first["r"])[-1]["message"].startswith("Cancelled") and service.adapters() == []


def test_without_the_environment_the_page_is_told_what_to_run(tmp_path: Path) -> None:
    client, _ = make(tmp_path, FakeRunner(), installed=False)
    assert client.get("/api/lora/info", headers=LAB).json()["ready"] is False
    r = client.post("/api/lora/train", headers=LAB, json=CONFIG)
    assert r.status_code == 503 and "pip install -r requirements.txt" in r.json()["error"]["message"]


# ----- publishing to Hugging Face (a fake hub runner: nothing leaves the machine) -----

class FakeHub(FakeRunner):
    """The training fake, plus publish_adapter.py's two jobs."""

    def __init__(self, signed_in: bool = True, fail: str = "", existing: dict | None = None) -> None:
        super().__init__()
        self.signed_in, self.hub_fail, self.hub_jobs, self.existing = signed_in, fail, [], existing

    def __call__(self, argv, job, on_line, cancelled, timeout_s):  # type: ignore[override]
        if not argv[-1].endswith("publish_adapter.py"):
            return super().__call__(argv, job, on_line, cancelled, timeout_s)
        j = json.loads(job)
        self.hub_jobs.append(j)
        if not self.signed_in:
            on_line({"type": "error", "message": "Not signed in to Hugging Face.", "signed_in": False})
            return 1
        if j["action"] == "whoami":
            on_line({"type": "result", "name": "durjan-test", "orgs": []})
            return 0
        if j["action"] == "check":
            on_line({"type": "result", "exists": self.existing is not None,
                     "private": (self.existing or {}).get("private")})
            return 0
        if self.hub_fail:
            on_line({"type": "error", "message": self.hub_fail})
            return 1
        on_line({"type": "result", "url": f"https://huggingface.co/{j['repo_id']}", "private": j["private"],
                 "commit": "abc123", "files": ["adapter_model.safetensors", "adapter_config.json", "README.md"],
                 "account": "durjan-test"})
        return 0


def trained(client: TestClient) -> str:
    return events(client.post("/api/lora/train", headers=LAB, json=CONFIG))[-1]["adapter_id"]


def saved_result(**over: Any) -> dict[str, Any]:
    metrics = lambda v: {"n": 40, "valid_json": v, "right_keys": v, "all_fields": v,  # noqa: E731
                         "fields": {f: v for f in data.FIELDS}}
    return {"model_id": CONFIG["model_id"], "config": {"r": 16, "alpha": 32, "dropout": 0.05, "targets": ["q_proj"],
                                                       "lr": 5e-4, "steps": 80, "batch": 8, "seed": 0},
            "params": {"trainable": 4_884_480, "total": 134_515_008, "share": 0.0363},
            "sizes": {"adapter_bytes": 19_593_064}, "train_s": 47.2,
            "before": {"metrics": metrics(0.0)}, "after": {"metrics": metrics(1.0)}, **over}


def test_the_card_is_written_from_the_adapters_own_scores() -> None:
    card = data.model_card(saved_result(), "someone/smollm2-135m-order-email-json-lora")
    assert card.startswith("---\nbase_model: HuggingFaceTB/SmolLM2-135M-Instruct\nlibrary_name: peft\nlicense: apache-2.0")
    assert "| **Every field right** | **0%** | **100%** |" in card and "on 40 emails the adapter never saw" in card
    assert '"someone/smollm2-135m-order-email-json-lora"' in card and "4,884,480 trained parameters" in card
    assert data.SYSTEM.split(".")[0] in card  # the prompt it was trained with, to use it the same way
    assert data.suggested_repo("someone", CONFIG["model_id"]) == "someone/smollm2-135m-order-email-json-lora"


def test_staging_names_the_base_model_and_never_this_machine(tmp_path: Path) -> None:
    """PEFT writes the local folder the base model was loaded from into adapter_config.json, which names this
    machine's user and stops anyone else loading the adapter. It also writes its own README with that path."""
    adapter, stage = tmp_path / "adapter", tmp_path / "stage"
    adapter.mkdir()
    stage.mkdir()
    home = str(Path.home())
    (adapter / "adapter_model.safetensors").write_bytes(b"weights")
    (adapter / "adapter_config.json").write_text(json.dumps({"base_model_name_or_path": f"{home}/lab/models/x", "r": 16}))
    (adapter / "README.md").write_text(f"base_model: {home}/lab/models/x")
    (adapter / "result.json").write_text("{}")
    files = data.stage(adapter, stage, CONFIG["model_id"], "# card", [home])
    assert sorted(files) == ["README.md", "adapter_config.json", "adapter_model.safetensors"]
    assert sorted(p.name for p in stage.iterdir()) == sorted(files)  # never result.json or PEFT's README
    assert json.loads((stage / "adapter_config.json").read_text())["base_model_name_or_path"] == CONFIG["model_id"]
    assert (stage / "README.md").read_text() == "# card"
    for leaky in (f"Trained in {home}/lab", "fine"):
        stage2 = tmp_path / f"s{len(leaky)}"
        stage2.mkdir()
        if home in leaky:
            try:
                data.stage(adapter, stage2, CONFIG["model_id"], leaky, [home])
            except data.PrivatePath as exc:
                assert "README.md" in str(exc)
            else:
                raise AssertionError("a card naming this machine's folders was staged")


def test_publishing_asks_first_and_sends_what_the_page_showed(tmp_path: Path) -> None:
    hub = FakeHub()
    client, _ = make(tmp_path, hub)
    adapter = trained(client)
    me = client.get("/api/lora/account", headers=LAB, params={"model_id": CONFIG["model_id"]}).json()
    assert me["name"] == "durjan-test" and me["suggested"] == "durjan-test/smollm2-135m-order-email-json-lora"
    preview = client.post(f"/api/lora/adapters/{adapter}/card", headers=LAB, json={"repo_id": "durjan-test/my-lora"})
    assert preview.status_code == 200 and "durjan-test/my-lora" in preview.json()["card"]
    assert preview.json()["existing"] is None
    body = {"repo_id": "durjan-test/my-lora", "card": preview.json()["card"] + "\nEdited.", "private": True}
    assert client.post(f"/api/lora/adapters/{adapter}/publish", headers=LAB, json=body).status_code in (400, 422)
    assert [j["action"] for j in hub.hub_jobs] == ["whoami", "check"]  # no confirmation: nothing was sent
    done = client.post(f"/api/lora/adapters/{adapter}/publish", headers=LAB, json={**body, "confirm": True})
    assert done.status_code == 200 and done.json()["url"] == "https://huggingface.co/durjan-test/my-lora"
    job = hub.hub_jobs[-1]
    assert job["private"] is True and job["card"].endswith("Edited.") and job["adapter_dir"].endswith(adapter)
    assert job["model_id"] == CONFIG["model_id"] and job["replace_existing"] is False
    for bad in ("no-slash", "a/b/c", "../x", "me/bad name"):
        r = client.post(f"/api/lora/adapters/{adapter}/publish", headers=LAB, json={**body, "repo_id": bad, "confirm": True})
        assert r.status_code == 400
    assert client.post("/api/lora/adapters/ffffffffffff/publish", headers=LAB,
                       json={**body, "confirm": True}).status_code == 404


def test_not_signed_in_and_a_failed_upload_say_so(tmp_path: Path) -> None:
    client, _ = make(tmp_path, FakeHub(signed_in=False))
    got = client.get("/api/lora/account", headers=LAB).json()
    assert got["signed_in"] is False and "hf auth login" in got["sign_in"]
    client, _ = make(tmp_path / "b", FakeHub(fail="HfHubHTTPError: 403 Forbidden: no write access"))
    adapter = trained(client)
    r = client.post(f"/api/lora/adapters/{adapter}/publish", headers=LAB,
                    json={"repo_id": "x/y", "card": "# card for x/y adapter", "private": True, "confirm": True})
    assert r.status_code == 502 and "no write access" in r.json()["error"]["message"]


def test_an_existing_repo_is_shown_before_and_replaced_only_when_agreed(tmp_path: Path) -> None:
    """create_repo(exist_ok=True) then an upload replaced an existing repo's README and files, and put the adapter in
    a public repo even when private was asked for, with nothing said until afterwards."""
    hub = FakeHub(existing={"private": False})
    client, _ = make(tmp_path, hub)
    adapter = trained(client)
    preview = client.post(f"/api/lora/adapters/{adapter}/card", headers=LAB, json={"repo_id": "durjan-test/old"}).json()
    assert preview["existing"] == {"private": False}
    body = {"repo_id": "durjan-test/old", "card": preview["card"], "private": False, "confirm": True,
            "replace_existing": True}
    assert client.post(f"/api/lora/adapters/{adapter}/publish", headers=LAB, json=body).status_code == 200
    assert hub.hub_jobs[-1]["replace_existing"] is True  # the script refuses an existing repo without it


def test_a_card_for_an_adapter_without_its_scores_says_why(tmp_path: Path) -> None:
    client, service = make(tmp_path, FakeHub())
    adapter = trained(client)
    (service.adapters_dir / adapter / "result.json").write_text('{"model_id": "HuggingFaceTB/SmolLM2-135M-Instruct"}')
    r = client.post(f"/api/lora/adapters/{adapter}/card", headers=LAB, json={"repo_id": "x/y"})
    assert r.status_code == 400 and "without its scores" in r.json()["error"]["message"]


def test_only_publishing_gets_the_hugging_face_login(monkeypatch) -> None:
    """Training and trying download public models: they need no Hugging Face token, so they do not get one."""
    from backend.app.services import lora as lora_module

    seen: list[dict] = []

    class Proc:
        stdin = type("In", (), {"write": lambda s, x: None, "close": lambda s: None})()
        stdout = iter(())

        def poll(self):
            return 0

        def wait(self):
            return 0

    monkeypatch.setenv("HF_TOKEN", "hf_write_token")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-for-children")
    monkeypatch.setattr(lora_module.subprocess, "Popen", lambda *a, **k: seen.append(k["env"]) or Proc())
    lora_module.subprocess_runner(["python", "run_lora.py"], "{}", lambda e: None, threading.Event(), 5)
    lora_module.hub_runner(["python", "publish_adapter.py"], "{}", lambda e: None, threading.Event(), 5)
    assert "HF_TOKEN" not in seen[0] and seen[1]["HF_TOKEN"] == "hf_write_token"
    assert not any("ANTHROPIC_API_KEY" in env for env in seen)
