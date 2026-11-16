"""Image to 3D: the routes with a fake runner in place of Idol, so no PyTorch, no GPU and no download."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Callable

from fastapi.testclient import TestClient

from backend.app.api import deps
from backend.app.main import create_app
from backend.app.services import image_to_3d as i3
from backend.app.services.image_to_3d import ImageTo3DService
from backend.app.services.runs import RunRegistry, RunStreamer
from backend.app.settings import Settings
from backend.tests.test_aftercare import ScriptedClient
from backend.tests.test_api import LAB

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 64
SETTINGS = {"mode": "real", "seed": "7", "steps": "10", "num_gaussians": "65536"}


class FakeIdol:
    """Stands in for run_idol.py: replays its events and writes the files a real run would."""

    def __init__(self, fail: str = "", hold: threading.Event | None = None, write_ply: bool = True) -> None:
        self.fail, self.hold, self.write_ply, self.jobs, self.argv = fail, hold, write_ply, [], []

    def __call__(self, argv: list[str], job: str, on_line: Callable[[dict], None], cancelled: threading.Event,
                 timeout_s: float) -> int:
        j = json.loads(job)
        self.jobs.append(j)
        self.argv.append(argv)
        on_line({"type": "setup", "device": "mps", "torch": "2.15.0"})
        on_line({"type": "progress", "step": "Loading the weights", "elapsed_s": 1.0})
        if self.hold:
            self.hold.wait(5)
            if cancelled.is_set():
                return -9
        if self.fail:
            on_line({"type": "error", "message": self.fail})
            return 1
        out = Path(j["out_dir"])
        if self.write_ply:
            (out / "object.ply").write_bytes(b"ply\nformat binary_little_endian 1.0\nend_header\n")
        (out / "input.png").write_bytes(PNG)
        (out / "camera.json").write_text('{"yaw": 0.1}')
        on_line({"type": "result", "device": "mps", "load_s": 30.0, "generate_s": 200.0, "total_s": 231.0,
                 "ply_bytes": 50, "camera": {"yaw": 0.1}})
        return 0


def make(tmp_path: Path, runner: Any, installed: bool = True) -> tuple[TestClient, ImageTo3DService]:
    settings = Settings(port=8000, budget_usd=0.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    app = create_app(settings, client=ScriptedClient([]))
    python = tmp_path / "python"
    if installed:
        python.write_text("")
    service = ImageTo3DService(tmp_path / "image-to-3d", RunStreamer(RunRegistry(), 0.05), venv_python=python,
                               runner=runner)
    app.dependency_overrides[deps.image_to_3d] = lambda: service
    return TestClient(app, base_url="http://localhost:8000"), service


def events(response: Any) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def post(client: TestClient, image: bytes = PNG, **settings: str) -> Any:
    return client.post("/api/image-to-3d/generate", headers=LAB, data={**SETTINGS, **settings},
                       files={"file": ("chair.png", image, "image/png")})


def test_a_photo_becomes_a_saved_object_whose_files_can_be_fetched_and_deleted(tmp_path: Path) -> None:
    runner = FakeIdol()
    client, _ = make(tmp_path, runner)
    info = client.get("/api/image-to-3d/info", headers=LAB).json()
    assert info["ready"] and info["results"] == [] and 65_536 in info["limits"]["gaussians"] and len(info["gated"]) == 2

    got = events(post(client))  # no budget left, and still allowed: it runs on this machine and is free
    assert [e["type"] for e in got] == ["run", "progress", "setup", "progress", "done"]
    job = runner.jobs[0]
    assert (job["mode"], job["seed"], job["steps"], job["num_gaussians"]) == ("real", 7, 10, 65_536)
    assert job["image"].endswith("source.png") and Path(job["image"]).read_bytes() == PNG
    result = got[-1]["result"]
    assert result["device"] == "mps" and result["generate_s"] == 200.0 and result["settings"]["steps"] == 10

    [saved] = client.get("/api/image-to-3d/info", headers=LAB).json()["results"]
    assert saved["id"] == result["id"]
    ply = client.get(f"/api/image-to-3d/results/{saved['id']}/object.ply", headers=LAB)
    assert ply.status_code == 200 and ply.content.startswith(b"ply")
    assert client.get(f"/api/image-to-3d/results/{saved['id']}/object.ply").status_code == 403  # the lab header
    assert client.delete(f"/api/image-to-3d/results/{saved['id']}", headers=LAB).json() == {"deleted": saved["id"]}
    assert client.get(f"/api/image-to-3d/results/{saved['id']}/object.ply", headers=LAB).status_code == 404


def test_only_the_files_idol_writes_can_be_fetched(tmp_path: Path) -> None:
    client, _ = make(tmp_path, FakeIdol())
    rid = events(post(client))[-1]["result"]["id"]
    for name in ("result.json", "source.png", "..%2F..%2Fsecret", ".env"):
        assert client.get(f"/api/image-to-3d/results/{rid}/{name}", headers=LAB).status_code == 404
    assert client.get("/api/image-to-3d/results/..%2F..%2Fx/object.ply", headers=LAB).status_code in (404, 400)
    assert client.get(f"/api/image-to-3d/results/{rid}/input.png", headers=LAB).status_code == 200


def test_bad_input_is_refused_before_idol_runs(tmp_path: Path) -> None:
    runner = FakeIdol()
    client, _ = make(tmp_path, runner)
    assert post(client, image=b"GIF89a" + b"\0" * 40).status_code == 400  # not a PNG, JPEG or WebP, whatever its name
    assert post(client, num_gaussians="70000").status_code == 400
    assert post(client, steps="500").status_code == 400
    assert post(client, mode="cartoon").status_code == 400
    assert post(client, image=JPEG).status_code == 200 and runner.jobs[-1]["image"].endswith("source.jpg")
    assert len(runner.jobs) == 1


def test_not_installed_says_what_to_run(tmp_path: Path) -> None:
    client, _ = make(tmp_path, FakeIdol(), installed=False)
    r = post(client)
    assert r.status_code == 503 and i3.SETUP in r.json()["error"]["message"]
    assert client.get("/api/image-to-3d/info", headers=LAB).json()["ready"] is False


def test_a_failed_run_keeps_nothing_and_says_why(tmp_path: Path) -> None:
    client, service = make(tmp_path, FakeIdol(fail="GatedRepoError: 401\n\nIdol needs two gated models"))
    got = events(post(client))
    assert got[-1]["type"] == "error" and "gated models" in got[-1]["message"]
    assert service.results() == [] and not any((tmp_path / "image-to-3d").iterdir())
    client, service = make(tmp_path / "b", FakeIdol(write_ply=False))  # said it finished, but wrote no .ply
    assert events(post(client))[-1]["type"] == "error" and service.results() == []


def test_one_run_at_a_time_and_a_cancel_keeps_nothing(tmp_path: Path) -> None:
    hold = threading.Event()
    client, service = make(tmp_path, FakeIdol(hold=hold))
    first: dict[str, Any] = {}
    t = threading.Thread(target=lambda: first.update(r=post(client)))
    t.start()
    for _ in range(100):
        if service._busy.locked():
            break
        threading.Event().wait(0.02)
    assert post(client).status_code == 409
    assert client.post("/api/image-to-3d/cancel", headers=LAB).json() == {"cancelled": True}
    hold.set()
    t.join(5)
    assert events(first["r"])[-1] == {"type": "error", "message": "Cancelled. Nothing was saved."}
    assert service.results() == [] and not service._busy.locked()


def test_the_child_gets_no_lab_keys(monkeypatch, tmp_path: Path) -> None:
    """Idol runs third-party packages: it gets the Hugging Face login, never the backend's keys."""
    seen: dict[str, Any] = {}

    class Proc:
        stdin = type("In", (), {"write": lambda s, x: None, "close": lambda s: None})()
        stdout = iter(())  # no lines

        def poll(self):
            return 0

        def wait(self):
            return 0

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-for-idol")
    monkeypatch.setenv("HF_TOKEN", "hf_for_idol")
    monkeypatch.setattr(i3.subprocess, "Popen", lambda *a, **k: seen.update(k) or Proc())
    i3.subprocess_runner(["python", "run_idol.py"], "{}", lambda e: None, threading.Event(), 5)
    assert seen["env"]["HF_TOKEN"] == "hf_for_idol" and "ANTHROPIC_API_KEY" not in seen["env"]


def test_a_photo_over_the_limit_is_refused_before_it_is_read(tmp_path: Path) -> None:
    client, _ = make(tmp_path, FakeIdol())
    r = client.post("/api/image-to-3d/generate", headers={**LAB, "content-type": "multipart/form-data; boundary=x",
                                                          "content-length": str(i3.MAX_IMAGE_BYTES + 70 * 1024)},
                    content=b"")
    assert r.status_code == 413


# ----- review findings -----

def test_a_stream_never_read_leaves_no_lock_behind(tmp_path: Path) -> None:
    """The stream starts its work only when the response is first read. The lock was taken before that, so a page
    gone first left it held: every later request got 409 until a restart."""
    _, service = make(tmp_path, FakeIdol())
    unread = service.generate(PNG, {"mode": "real", "seed": 1, "steps": 10, "num_gaussians": 65_536})
    del unread  # never iterated, as when the client disconnects before the body is sent
    assert not service._busy.locked()
    lines = list(service.generate(PNG, {"mode": "real", "seed": 1, "steps": 10, "num_gaussians": 65_536}))
    assert json.loads(lines[-1])["type"] == "done"


def test_the_same_holds_for_lora(tmp_path: Path) -> None:
    from backend.app.services.lora import LoraService
    from backend.tests.test_lora import CONFIG, FakeRunner

    python = tmp_path / "python"
    python.write_text("")
    lora = LoraService(tmp_path / "lora", RunStreamer(RunRegistry(), 0.05), venv_python=python, runner=FakeRunner())
    unread = lora.train(dict(CONFIG))
    del unread
    assert not lora._busy.locked()
    assert json.loads(list(lora.train(dict(CONFIG)))[-1])["type"] == "done"


def test_one_broken_result_does_not_hide_the_others(tmp_path: Path) -> None:
    client, service = make(tmp_path, FakeIdol())
    rid = events(post(client))[-1]["result"]["id"]
    bad = tmp_path / "image-to-3d" / "abcdefabcdef"
    bad.mkdir()
    (bad / "result.json").write_text('{"settings": {"steps": 1')  # half written
    info = client.get("/api/image-to-3d/info", headers=LAB)
    assert info.status_code == 200 and [r["id"] for r in info.json()["results"]] == [rid]


def test_stray_json_from_the_script_never_reaches_the_page(tmp_path: Path) -> None:
    class Noisy(FakeIdol):
        def __call__(self, argv, job, on_line, cancelled, timeout_s):  # type: ignore[override]
            on_line({"type": "done"})  # a library printing JSON of its own
            on_line({"type": "run", "run_id": "x"})
            return super().__call__(argv, job, on_line, cancelled, timeout_s)

    client, _ = make(tmp_path, Noisy())
    got = events(post(client))
    assert [e["type"] for e in got] == ["run", "progress", "setup", "progress", "done"] and "result" in got[-1]


def test_a_run_past_the_time_limit_says_so(monkeypatch) -> None:
    """A slow run was killed and reported as a crash ("exit code -9"), with advice to debug it by hand."""
    import sys

    seen: list[dict] = []
    i3.subprocess_runner([sys.executable, "-c", "import time; time.sleep(10)"], "{}", seen.append, threading.Event(), 0.2)
    assert seen and seen[-1]["type"] == "error" and "time limit" in seen[-1]["message"]
    cancelled = threading.Event()
    cancelled.set()
    seen.clear()
    i3.subprocess_runner([sys.executable, "-c", "import time; time.sleep(10)"], "{}", seen.append, cancelled, 60)
    assert seen == []  # a cancel is not a time limit


def test_the_script_explains_memory_and_access_problems_apart() -> None:
    """A memory error mentioning "1401.00 MiB" matched '401' and was reported as a Hugging Face sign-in problem."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("_run_idol", i3.FOLDER / "run_idol.py")
    run_idol = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(run_idol)
    oom = run_idol.explain(RuntimeError("MPS backend out of memory. Tried to allocate 1401.00 MiB"))
    assert "fewer Gaussians" in oom and "hf auth login" not in oom
    for exc in (type("GatedRepoError", (Exception,), {})("Access to model is restricted"),
                OSError("401 Client Error: Unauthorized for url"), ValueError("This repo is gated")):
        assert "hf auth login" in run_idol.explain(exc)
    assert run_idol.explain(ValueError("token budget too small")) == "ValueError: token budget too small"


def test_children_keep_this_machines_way_to_the_internet(monkeypatch) -> None:
    from backend.app.core.child_env import child_env

    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.internal:3128")
    monkeypatch.setenv("SSL_CERT_FILE", "/etc/ssl/company.pem")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-for-children")
    env = child_env()
    assert env["HTTPS_PROXY"] == "http://proxy.internal:3128" and env["SSL_CERT_FILE"] == "/etc/ssl/company.pem"
    assert "ANTHROPIC_API_KEY" not in env
