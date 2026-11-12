"""The code knowledge graph: parsing, import resolution, call edges and the archive checks on small made-up code bases,
then a question through the API with a scripted model. No network, no cost."""
from __future__ import annotations

import base64
import io
import json
import shutil
import stat
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services import code_graph as cg
from backend.app.settings import Settings
from backend.app.shared import ROOT
from backend.tests.test_aftercare import ScriptedClient, text, use
from backend.tests.test_api import LAB

PY = {
    "pkg/__init__.py": "",
    "pkg/base.py": "class Animal:\n    def speak(self):\n        return self.sound()\n\n    def sound(self):\n        return ''\n",
    "pkg/dog.py": "from .base import Animal\n\n\nclass Dog(Animal):\n    def sound(self):\n        return bark()\n\n\n"
                  "def bark():\n    return 'woof'\n",
    "app.py": "import json\nfrom pkg.dog import Dog\n\n\ndef main():\n    return Dog().speak()\n",
}
TS = {
    "web/src/lib/util.ts": "export function shout(s: string): string { return s.toUpperCase(); }\n"
                           "export interface Named { name: string }\n",
    "web/src/pages/Home.tsx": "import { shout } from '@/lib/util';\nimport React from 'react';\n"
                              "export interface Person extends Named { age: number }\n"
                              "export default function Home() { return <Badge text={shout('hi')} />; }\n"
                              "const Badge = ({ text }: { text: string }) => <b>{text}</b>;\n",
    "web/src/main.ts": "const page = () => import('./pages/Home');\nexport class App { go() { this.load(); } load() { page(); } }\n",
}

JS_READY = shutil.which("node") is not None and (ROOT / "frontend" / "node_modules" / "rolldown").exists()


def write(root: Path, files: dict[str, str]) -> Path:
    for name, body in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(body)
    return root


def edges(graph: dict, kind: str) -> set[tuple[str, str]]:
    return {(e["s"], e["t"]) for e in graph["edges"] if e["kind"] == kind}


def test_python_is_parsed_into_symbols_imports_and_calls() -> None:
    p = cg.parse_python(PY["pkg/dog.py"])
    assert [(s["kind"], s["qual"]) for s in p["symbols"]] == [("class", "Dog"), ("method", "Dog.sound"), ("function", "bark")]
    assert p["symbols"][0]["bases"] == ["Animal"]
    assert p["imports"] == [{"source": "base", "names": ["Animal"], "level": 1, "line": 1}]
    assert {"caller": "Dog.sound", "name": "bark", "receiver": None, "cls": "Dog", "line": 6} in p["calls"]
    assert "error" in cg.parse_python("def broken(:\n")


def test_python_imports_calls_and_inheritance_are_joined(tmp_path: Path) -> None:
    g = cg.analyse(write(tmp_path, PY))
    assert ("file:app.py", "file:pkg/dog.py") in edges(g, "imports")
    assert ("file:pkg/dog.py", "file:pkg/base.py") in edges(g, "imports")  # a relative import
    calls = {(e["s"], e["t"]): e["how"] for e in g["edges"] if e["kind"] == "calls"}
    assert calls[("sym:pkg/dog.py::Dog.sound", "sym:pkg/dog.py::bark")] == "same file"
    assert calls[("sym:pkg/base.py::Animal.speak", "sym:pkg/base.py::Animal.sound")] == "same class"
    assert calls[("sym:app.py::main", "sym:pkg/dog.py::Dog")] == "imported file"
    assert ("sym:pkg/dog.py::Dog", "sym:pkg/base.py::Animal") in edges(g, "extends")
    assert g["external"]["app.py"] == ["json"]


@pytest.mark.skipif(not JS_READY, reason="needs Node and the frontend's packages")
def test_typescript_is_parsed_with_aliases_lazy_imports_and_jsx(tmp_path: Path) -> None:
    g = cg.analyse(write(tmp_path, TS))
    kinds = {n["id"]: n["kind"] for n in g["nodes"]}
    assert kinds["sym:web/src/pages/Home.tsx::Home"] == "function"
    assert kinds["sym:web/src/pages/Home.tsx::Badge"] == "function"  # an arrow function in a const
    assert kinds["sym:web/src/lib/util.ts::Named"] == "interface"
    assert kinds["sym:web/src/main.ts::App.go"] == "method"
    imports = edges(g, "imports")
    assert ("file:web/src/pages/Home.tsx", "file:web/src/lib/util.ts") in imports  # '@/' is the src folder
    assert ("file:web/src/main.ts", "file:web/src/pages/Home.tsx") in imports  # import() inside a function
    calls = edges(g, "calls")
    assert ("sym:web/src/pages/Home.tsx::Home", "sym:web/src/lib/util.ts::shout") in calls
    assert ("sym:web/src/pages/Home.tsx::Home", "sym:web/src/pages/Home.tsx::Badge") in calls  # <Badge /> is a call
    assert ("sym:web/src/main.ts::App.go", "sym:web/src/main.ts::App.load") in calls  # this.load()
    assert ("sym:web/src/pages/Home.tsx::Person", "sym:web/src/lib/util.ts::Named") in edges(g, "extends")  # util.ts is imported
    assert g["external"]["web/src/pages/Home.tsx"] == ["react"]


def test_common_names_are_not_joined_across_files(tmp_path: Path) -> None:
    files = {"a.py": "def get():\n    pass\n\ndef unusual_helper():\n    pass\n",
             "b.py": "def run_it():\n    get()\n    unusual_helper()\n"}
    g = cg.analyse(write(tmp_path, files))
    calls = {(e["s"], e["t"]): e["how"] for e in g["edges"] if e["kind"] == "calls"}
    assert calls == {("sym:b.py::run_it", "sym:a.py::unusual_helper"): "only definition"}


def zip_of(entries: dict[str, bytes], links: tuple[str, ...] = ()) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
        for name in links:
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, "/etc/passwd")
    return buf.getvalue()


def test_archives_are_unpacked_safely(tmp_path: Path) -> None:
    good = zip_of({"repo-main/app.py": b"x = 1\n", "repo-main/README.md": b"hi"}, links=("repo-main/link.py",))
    assert cg.safe_extract(good, tmp_path / "a") == 1  # the top folder stripped, the link and the README skipped
    assert (tmp_path / "a" / "app.py").exists() and not (tmp_path / "a" / "link.py").exists()
    for bad in ("../evil.py", "/abs/evil.py", "a/../../evil.py"):
        with pytest.raises(ApiError, match="unsafe"):
            cg.safe_extract(zip_of({bad: b"x"}), tmp_path / "b")
    assert not (tmp_path / "evil.py").exists()
    with pytest.raises(ApiError, match="not a ZIP"):
        cg.safe_extract(b"not a zip", tmp_path / "c")


def test_only_github_repository_addresses_are_fetched() -> None:
    fetched = []
    label, data = cg.download_github("https://github.com/owner/repo.git", lambda url: fetched.append(url) or b"zip")
    assert label == "owner/repo" and fetched == ["https://github.com/owner/repo/archive/HEAD.zip"]
    for bad in ("https://gitlab.com/a/b", "http://github.com/a/b", "https://github.com/a/b/../../x", "https://github.com/a"):
        with pytest.raises(ApiError):
            cg.download_github(bad, lambda url: b"")


def test_a_question_through_the_api_uses_the_graph_tools(tmp_path: Path) -> None:
    fake = ScriptedClient([
        [use("search_symbols", {"query": "bark"})],
        [use("callers_of", {"ref": "bark"}, 2), use("get_node", {"ref": "pkg/dog.py::bark"}, 3)],
        [text("`bark` (pkg/dog.py:9) is called by `Dog.sound` (pkg/dog.py:5).")],
    ])
    settings = Settings(port=8000, budget_usd=2.0, generated_dir=tmp_path, frontend_dist=tmp_path / "dist",
                        models_dir=tmp_path / "no-models")
    client = TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")
    archive = zip_of({f"proj/{k}": v.encode() for k, v in PY.items()})
    meta = client.post("/api/code-graph/upload", headers=LAB,
                       json={"name": "proj.zip", "data": base64.b64encode(archive).decode()}).json()
    gid = meta["id"]
    assert meta["counts"]["class"] == 2 and meta["files"] == 4
    graph = client.get(f"/api/code-graph/{gid}", headers=LAB).json()
    assert len(graph["nodes"]) > 8
    detail = client.get(f"/api/code-graph/{gid}/node", headers=LAB, params={"id": "sym:pkg/dog.py::Dog"}).json()
    assert "class Dog(Animal)" in detail["code"] and detail["extends"][0]["name"] == "Animal"
    r = client.post(f"/api/code-graph/{gid}/ask", headers=LAB,
                    json={"question": "What calls bark?", "model": "claude-haiku-5-5"}).json()
    assert [s["tool"] for s in r["steps"]] == ["search_symbols", "callers_of", "get_node"]
    assert "sym:pkg/dog.py::Dog.sound" in r["used"] and "pkg/dog.py:9" in r["answer"]
    sent = fake.calls[1][1]
    assert {t["name"] for t in sent["tools"]} >= {"search_symbols", "get_node", "callers_of", "callees_of", "imports_of",
                                                  "file_outline"}
    result = json.loads(sent["messages"][2]["content"][0]["content"])  # the first tool result
    assert result["matches"][0]["id"] == "sym:pkg/dog.py::bark"
    assert client.get("/api/code-graph/../../etc", headers=LAB).status_code == 404
    assert client.get("/api/code-graph/zzzzzzzzzzzz", headers=LAB).status_code == 404
    assert any(s["id"] == gid for s in client.get("/api/code-graph/info", headers=LAB).json()["sources"])
