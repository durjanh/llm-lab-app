"""The code knowledge graph: turns a code base into a graph of folders, files, classes, functions, imports and calls,
then answers questions about it with a model that can only look through the graph.

The analysis is code, in four passes, and never runs the code it reads:
1. the file structure;
2. every Python file parsed with the standard `ast` module, and every JavaScript or TypeScript file with oxc (through
   rolldown's parser, which the frontend already installs), in a Node subprocess;
3. imports resolved to the files they name;
4. calls joined to the functions they name. Calls are matched by name, so the call graph is approximate: a call is
   joined when the name is defined in the same file, in a file it imports, or only once in the whole code base; common
   names such as `get` or `map` are joined only in the first two cases. Each call edge says which rule joined it.

The chat sends the model only what it asks for through its tools (a search, one function's code, who calls what), so
the whole code base never leaves the machine; with the local model nothing does.
"""
from __future__ import annotations

import ast
import base64
import hashlib
import io
import json
import re
import shutil
import subprocess
import threading
import time
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, ROOT, text_of
from .spend import SpendTracker

LANGS = {".py": "python", ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js"}
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "env", "__pycache__", "dist", "build", "generated", "models",
             "sites", ".next", "coverage", "site-packages", ".mypy_cache", ".pytest_cache", "vendor", "third_party"}
MAX_FILES = 3000
MAX_FILE_BYTES = 300_000  # bigger files are usually generated or minified
MAX_ARCHIVE_BYTES = 25 * 2**20  # a download or upload
MAX_UNPACKED_BYTES = 120 * 2**20
MAX_MEMBERS = 20_000
MAX_ROUNDS = 8
LAB_ID = "lab"
GITHUB = re.compile(r"^https://github\.com/([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$")

# Names too common to join across files on the name alone.
COMMON = set("""get set add append update pop remove delete clear copy keys values items map filter reduce forEach some
every find includes join split strip replace format push slice splice concat sort reverse indexOf toString valueOf
then catch finally log error warn info debug print len str int float list dict tuple open close read write send post
put patch create run start stop load save emit on off call apply bind next init render test assert setState useState
useEffect useRef useMemo useCallback json parse stringify resolve reject has max min abs round floor ceil now
encode decode lower upper startswith endswith exists mkdir unlink glob rglob search match group sub fetch request
response main execute handle process build make new from of to is it describe expect""".split())


# ------------------------------------------------------------------------------------------------- pass 1: files

def list_files(root: Path, use_git: bool = False) -> tuple[list[str], list[str]]:
    """The source files under root (relative POSIX paths), and notes on what was left out."""
    notes: list[str] = []
    names: list[str] = []
    if use_git and (root / ".git").exists() and shutil.which("git"):
        out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=root,
                             capture_output=True, text=True, timeout=30)
        names = [n for n in out.stdout.splitlines() if n]
    else:
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(root)
            if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts[:-1]):
                continue
            if p.is_file() and not p.is_symlink():
                names.append(rel.as_posix())
    files, big = [], 0
    for n in names:
        if PurePosixPath(n).suffix.lower() not in LANGS or any(part in SKIP_DIRS for part in PurePosixPath(n).parts[:-1]):
            continue
        p = root / n
        if not p.is_file() or p.is_symlink():
            continue
        if p.stat().st_size > MAX_FILE_BYTES or n.endswith((".min.js", ".bundle.js")):
            big += 1
            continue
        files.append(n)
    if big:
        notes.append(f"{big} files over {MAX_FILE_BYTES // 1000} kB or minified were left out")
    if len(files) > MAX_FILES:
        notes.append(f"only the first {MAX_FILES} of {len(files)} source files were read")
        files = files[:MAX_FILES]
    return files, notes


# --------------------------------------------------------------------------------------------- pass 2: parsing

class _PyVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.symbols: list[dict] = []
        self.imports: list[dict] = []
        self.calls: list[dict] = []
        self.owner: str | None = None
        self.cls: str | None = None

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.imports.append({"source": alias.name, "names": [], "level": 0, "line": node.lineno})

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        self.imports.append({"source": node.module or "", "names": [a.name for a in node.names],
                             "level": node.level, "line": node.lineno})

    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if self.owner is not None and self.cls is None:  # a function inside a function: part of its owner
            self.generic_visit(node)
            return
        if self.cls is not None and self.owner == self.cls:
            qual, kind = f"{self.cls}.{node.name}", "method"
        elif self.owner is None:
            qual, kind = node.name, "function"
        else:
            self.generic_visit(node)
            return
        self.symbols.append({"kind": kind, "name": node.name, "qual": qual, "parent": self.cls if kind == "method" else None,
                             "start": node.lineno, "end": node.end_lineno or node.lineno})
        outer = self.owner
        self.owner = qual
        self.generic_visit(node)
        self.owner = outer

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        if self.owner is not None:
            self.generic_visit(node)
            return
        bases = []
        for b in node.bases:
            if isinstance(b, ast.Name):
                bases.append(b.id)
            elif isinstance(b, ast.Attribute):
                bases.append(b.attr)
        self.symbols.append({"kind": "class", "name": node.name, "qual": node.name, "bases": bases,
                             "start": node.lineno, "end": node.end_lineno or node.lineno})
        self.owner, self.cls = node.name, node.name
        self.generic_visit(node)
        self.owner, self.cls = None, None

    def visit_Call(self, node: ast.Call) -> None:
        f = node.func
        if isinstance(f, ast.Name):
            self.calls.append({"caller": self.owner, "name": f.id, "receiver": None, "cls": self.cls, "line": node.lineno})
        elif isinstance(f, ast.Attribute):
            recv = f.value.id if isinstance(f.value, ast.Name) else None
            self.calls.append({"caller": self.owner, "name": f.attr, "receiver": recv, "cls": self.cls, "line": node.lineno})
        self.generic_visit(node)


def parse_python(text: str) -> dict[str, Any]:
    """Symbols, imports and calls in one Python file. A file that does not parse gives an error and nothing else."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError) as exc:
        return {"error": f"does not parse: {exc}"[:300]}
    v = _PyVisitor()
    v.visit(tree)
    return {"symbols": v.symbols, "imports": v.imports, "calls": v.calls, "lines": text.count("\n") + 1}


def parse_js(root: Path, files: list[str]) -> dict[str, dict]:
    """Symbols, imports and calls for JavaScript and TypeScript files, from the Node script. Empty if Node or the
    parser is missing (the caller says so)."""
    node = shutil.which("node")
    frontend = ROOT / "frontend"
    if not files or not node or not (frontend / "node_modules" / "rolldown").exists():
        return {}
    script = Path(__file__).with_name("code_graph_js.cjs")
    out: dict[str, dict] = {}
    for i in range(0, len(files), 400):  # batches keep each subprocess's output a sensible size
        batch = files[i:i + 400]
        done = subprocess.run([node, str(script)], input=json.dumps({"root": str(root), "frontend": str(frontend),
                                                                     "files": batch}),
                              capture_output=True, text=True, timeout=120)
        if done.returncode != 0:
            raise ApiError(500, "parser_failed", f"The JavaScript parser failed: {done.stderr.strip()[:300]}")
        out.update(json.loads(done.stdout))
    return out


# ---------------------------------------------------------------------------------------- pass 3: imports

def _python_modules(files: list[str]) -> dict[str, list[str]]:
    """Dotted module names to the files that could be them. Every suffix counts, because code is often run with a
    sub-folder on sys.path (backend.app.x, app.x and x all name backend/app/x.py)."""
    names: dict[str, list[str]] = defaultdict(list)
    for f in files:
        if not f.endswith(".py"):
            continue
        parts = list(PurePosixPath(f).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        for i in range(len(parts)):
            if parts[i:]:
                names[".".join(parts[i:])].append(f)
    return names


def resolve_python_import(f: str, imp: dict, modules: dict[str, list[str]]) -> list[str]:
    """The files an import statement in f names. Relative imports are worked out from f's folder."""
    level, source = imp.get("level", 0), imp.get("source", "")
    if level:
        pkg = list(PurePosixPath(f).parent.parts)
        if level > 1:
            pkg = pkg[: len(pkg) - (level - 1)]
        base = ".".join(pkg + ([source] if source else []))
        candidates = [base] + [f"{base}.{n}" for n in imp.get("names", [])]
        found = []
        for c in candidates:
            hits = [h for h in modules.get(c, []) if ".".join(PurePosixPath(h).with_suffix("").parts).replace(".__init__", "") == c]
            found += hits
        return sorted(set(found))
    found = []
    for c in [source] + [f"{source}.{n}" for n in imp.get("names", [])]:
        hits = modules.get(c, [])
        if len(hits) == 1:
            found.append(hits[0])
        elif hits:  # more than one file fits: prefer one near f
            near = sorted(hits, key=lambda h: -len(_common_prefix(PurePosixPath(h).parts, PurePosixPath(f).parts)))
            found.append(near[0])
    return sorted(set(found))


def _common_prefix(a: tuple, b: tuple) -> tuple:
    out = []
    for x, y in zip(a, b):
        if x != y:
            break
        out.append(x)
    return tuple(out)


JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]


def resolve_js_import(f: str, source: str, files: set[str]) -> str | None:
    """The file an import names: relative paths, and '@/' for the src folder of the project f sits in."""
    if source.startswith("."):
        base = PurePosixPath(f).parent / source
    elif source.startswith("@/"):
        parts = PurePosixPath(f).parts
        if "src" not in parts:
            return None
        base = PurePosixPath(*parts[: parts.index("src") + 1]) / source[2:]
    else:
        return None  # a package
    norm: list[str] = []
    for part in base.parts:
        if part == "..":
            if norm:
                norm.pop()
        elif part != ".":
            norm.append(part)
    stem = "/".join(norm)
    tries = [stem]
    if PurePosixPath(stem).suffix in (".js", ".jsx", ".mjs"):
        tries.append(stem.rsplit(".", 1)[0])  # import './x.js' in TypeScript means x.ts
    for t in list(tries):
        tries += [t + e for e in JS_EXTS] + [f"{t}/index{e}" for e in JS_EXTS]
    return next((t for t in tries if t in files), None)


# --------------------------------------------------------------------------------------------- the graph

def build_graph(root: Path, files: list[str], parsed: dict[str, dict], notes: list[str]) -> dict[str, Any]:
    """Nodes and edges from the parsed files: contains, imports, calls and extends."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    fileset = set(files)

    def add(node: dict) -> None:
        nodes[node["id"]] = node

    for f in files:
        parts = PurePosixPath(f).parts
        for i in range(1, len(parts)):
            folder = "/".join(parts[:i])
            if f"dir:{folder}" not in nodes:
                add({"id": f"dir:{folder}", "kind": "folder", "name": parts[i - 1], "file": folder})
                if i > 1:
                    edges.append({"s": f"dir:{'/'.join(parts[:i - 1])}", "t": f"dir:{folder}", "kind": "contains"})
        p = parsed.get(f, {})
        add({"id": f"file:{f}", "kind": "file", "name": parts[-1], "file": f, "lang": LANGS[PurePosixPath(f).suffix.lower()],
             "lines": p.get("lines", 0), **({"error": p["error"]} if p.get("error") else {})})
        if len(parts) > 1:
            edges.append({"s": f"dir:{'/'.join(parts[:-1])}", "t": f"file:{f}", "kind": "contains"})
        for s in p.get("symbols", []):
            sid = f"sym:{f}::{s['qual']}"
            add({"id": sid, "kind": s["kind"], "name": s["name"], "qual": s["qual"], "file": f, "line": s["start"],
                 "end": s["end"], **({"bases": s["bases"]} if s.get("bases") else {})})
            parent = f"sym:{f}::{s['parent']}" if s.get("parent") else f"file:{f}"
            edges.append({"s": parent, "t": sid, "kind": "contains"})

    # imports
    modules = _python_modules(files)
    imports_of: dict[str, set[str]] = defaultdict(set)
    external: dict[str, set[str]] = defaultdict(set)
    for f in files:
        for imp in parsed.get(f, {}).get("imports", []):
            if f.endswith(".py"):
                targets = resolve_python_import(f, imp, modules)
            else:
                t = resolve_js_import(f, imp.get("source", ""), fileset)
                targets = [t] if t else []
            for t in targets:
                if t != f:
                    imports_of[f].add(t)
            if not targets and imp.get("source"):
                external[f].add(imp["source"].split("/")[0] if not imp["source"].startswith("@") else "/".join(imp["source"].split("/")[:2]))
    for f, ts in imports_of.items():
        for t in sorted(ts):
            edges.append({"s": f"file:{f}", "t": f"file:{t}", "kind": "imports"})

    # calls and extends, joined by name
    by_name: dict[str, list[str]] = defaultdict(list)
    for n in nodes.values():
        if n["kind"] in ("function", "method", "class", "interface"):
            by_name[n["name"]].append(n["id"])

    def join(name: str, f: str, prefer_cls: str | None, receiver: str | None) -> tuple[str | None, str]:
        found = by_name.get(name, [])
        if not found:
            return None, ""
        if receiver in ("self", "cls", "this") and prefer_cls:
            own = f"sym:{f}::{prefer_cls}.{name}"
            if own in nodes:
                return own, "same class"
        same = [c for c in found if nodes[c]["file"] == f and nodes[c]["kind"] != "method"]
        if receiver is None and same:
            return same[0], "same file"
        same_any = [c for c in found if nodes[c]["file"] == f]
        if same_any and receiver is not None:
            return same_any[0], "same file"
        imported = [c for c in found if nodes[c]["file"] in imports_of.get(f, ())]
        if len(imported) == 1:
            return imported[0], "imported file"
        if len(found) == 1 and name not in COMMON and len(name) > 3:
            return found[0], "only definition"
        return None, ""

    seen: set[tuple[str, str]] = set()
    calls = 0
    for f in files:
        for c in parsed.get(f, {}).get("calls", []):
            caller = f"sym:{f}::{c['caller']}" if c.get("caller") else f"file:{f}"
            if caller not in nodes:
                caller = f"file:{f}"
            target, how = join(c["name"], f, c.get("cls"), c.get("receiver"))
            if not target or target == caller or (caller, target) in seen:
                continue
            seen.add((caller, target))
            edges.append({"s": caller, "t": target, "kind": "calls", "how": how})
            calls += 1
    for n in list(nodes.values()):
        for base in n.get("bases", []):
            target, how = join(base, n["file"], None, None)
            if target and nodes[target]["kind"] in ("class", "interface") and target != n["id"]:
                edges.append({"s": n["id"], "t": target, "kind": "extends", "how": how})

    counts: dict[str, int] = defaultdict(int)
    for n in nodes.values():
        counts[n["kind"]] += 1
    ecounts: dict[str, int] = defaultdict(int)
    for e in edges:
        ecounts[e["kind"]] += 1
    errors = [n["file"] for n in nodes.values() if n.get("error")]
    if errors:
        notes.append(f"{len(errors)} files did not parse: {', '.join(errors[:5])}{'…' if len(errors) > 5 else ''}")
    return {"nodes": list(nodes.values()), "edges": edges, "counts": dict(counts), "edge_counts": dict(ecounts),
            "external": {f: sorted(v) for f, v in external.items()}, "notes": notes}


def analyse(root: Path, use_git: bool = False) -> dict[str, Any]:
    """The four passes over one code base."""
    t0 = time.monotonic()
    files, notes = list_files(root, use_git)
    py = [f for f in files if f.endswith(".py")]
    js = [f for f in files if not f.endswith(".py")]
    parsed: dict[str, dict] = {}
    for f in py:
        parsed[f] = parse_python((root / f).read_text(errors="replace"))
    if js:
        found = parse_js(root, js)
        if not found:
            notes.append("JavaScript and TypeScript were not parsed: this machine needs Node and the frontend's packages")
        parsed.update(found)
    graph = build_graph(root, files, parsed, notes)
    graph["files"] = len(files)
    graph["took_s"] = round(time.monotonic() - t0, 2)
    return graph


# ----------------------------------------------------------------------------------------- archives

def safe_extract(data: bytes, dest: Path) -> int:
    """Unpacks a ZIP's source files into dest. Refuses absolute paths, '..', links, too many members and too many
    bytes; strips a single top-level folder (GitHub archives have one). Returns the number of files written."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ApiError(400, "invalid_request", "That is not a ZIP file.") from None
    infos = zf.infolist()
    if len(infos) > MAX_MEMBERS:
        raise ApiError(400, "too_big", f"The archive has more than {MAX_MEMBERS} entries.")
    if sum(i.file_size for i in infos) > MAX_UNPACKED_BYTES:
        raise ApiError(400, "too_big", f"The archive unpacks to more than {MAX_UNPACKED_BYTES // 2**20} MB.")
    names = [i.filename for i in infos if not i.is_dir()]
    tops = {n.split("/", 1)[0] for n in names}
    strip = len(tops) == 1 and all("/" in n for n in names)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    written = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if info.is_dir():
            continue
        if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in PurePosixPath(name).parts:
            raise ApiError(400, "unsafe_archive", f"The archive has an unsafe path: {name[:120]}")
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            continue  # a symbolic link: never followed, never written
        if strip:
            name = name.split("/", 1)[1]
        if PurePosixPath(name).suffix.lower() not in LANGS or info.file_size > MAX_FILE_BYTES:
            continue  # only source files are needed
        target = (dest / name).resolve()
        if not target.is_relative_to(root):
            raise ApiError(400, "unsafe_archive", f"The archive has an unsafe path: {name[:120]}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(zf.read(info))
        written += 1
    return written


def download_github(url: str, fetch: Callable[[str], bytes] | None = None) -> tuple[str, bytes]:
    """A public repository's default branch as a ZIP, capped in size. No tokens: private repositories fail."""
    m = GITHUB.match(url.strip())
    if not m:
        raise ApiError(400, "invalid_request", "Give a public GitHub repository address, such as https://github.com/owner/repo.")
    owner, repo = m.groups()
    archive = f"https://github.com/{owner}/{repo}/archive/HEAD.zip"
    data = (fetch or _fetch)(archive)
    return f"{owner}/{repo}", data


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "llm-lab-code-graph"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            host = urllib.request.urlparse(r.geturl()).hostname or ""
            if host not in ("github.com", "codeload.github.com"):
                raise ApiError(400, "invalid_request", "The download was redirected away from GitHub.")
            chunks, size = [], 0
            while chunk := r.read(1 << 16):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise ApiError(400, "too_big", f"The repository is over {MAX_ARCHIVE_BYTES // 2**20} MB as a ZIP.")
                chunks.append(chunk)
            return b"".join(chunks)
    except urllib.error.HTTPError as exc:
        raise ApiError(404 if exc.code == 404 else 502, "not_found",
                       "GitHub did not return that repository. Check the address; private repositories are not supported.") from None
    except urllib.error.URLError as exc:
        raise ApiError(502, "network", f"GitHub could not be reached: {exc.reason}") from None


# ------------------------------------------------------------------------------------------------ the chat

def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"name": name, "description": description,
            "input_schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}


REF = {"type": "string", "description": "A node id from another tool, a file path, or a name such as ClassName.method"}
TOOLS = [
    _tool("search_symbols", "Find files, classes, functions, methods and interfaces whose name or path contains the "
          "words. Returns up to 20 ids with where they are.",
          {"query": {"type": "string"}, "kind": {"type": "string", "enum": ["any", "file", "class", "function", "method", "interface"]}},
          ["query"]),
    _tool("get_node", "The code of one function, method or class (truncated), or the outline of a file.", {"ref": REF}, ["ref"]),
    _tool("callers_of", "What calls this function, method or class (approximate: calls are matched by name).", {"ref": REF}, ["ref"]),
    _tool("callees_of", "What this function, method or file calls (approximate: calls are matched by name).", {"ref": REF}, ["ref"]),
    _tool("imports_of", "The files a file imports, the files that import it, and the packages it uses.", {"ref": REF}, ["ref"]),
    _tool("file_outline", "The classes, functions and methods in one file, with their lines.", {"ref": REF}, ["ref"]),
    _tool("subclasses_of", "Classes and interfaces that extend or implement this one.", {"ref": REF}, ["ref"]),
]

SYSTEM = """You answer questions about a code base. You cannot see the code base directly: you see it only through
tools over a graph that code built from it (files, classes, functions, methods, imports, calls and inheritance).

- Start with search_symbols, then follow callers_of, callees_of, imports_of and get_node. Read the code with get_node
  before explaining how something works.
- Call edges were matched by name, so they can be missing or wrong where names repeat; say so when it matters.
- Answer in plain English, briefly. Name every function or file you rely on as `path:line`. If the tools do not show
  the answer, say what you looked at and what is missing; do not guess."""


class GraphIndex:
    """Lookups over one analysed graph, for the chat tools and the page's side panel."""

    def __init__(self, graph: dict, root: Path):
        self.graph, self.root = graph, root
        self.nodes = {n["id"]: n for n in graph["nodes"]}
        self.out: dict[str, list[dict]] = defaultdict(list)
        self.into: dict[str, list[dict]] = defaultdict(list)
        for e in graph["edges"]:
            self.out[e["s"]].append(e)
            self.into[e["t"]].append(e)

    def find(self, ref: str) -> dict | None:
        ref = (ref or "").strip()
        if ref in self.nodes:
            return self.nodes[ref]
        for prefix in ("file:", "sym:", "dir:"):
            if prefix + ref in self.nodes:
                return self.nodes[prefix + ref]
        if "::" in ref and "sym:" + ref in self.nodes:
            return self.nodes["sym:" + ref]
        if ":" in ref and not ref.startswith(("file:", "sym:", "dir:")):
            path, _, line = ref.rpartition(":")
            if line.isdigit() and "file:" + path in self.nodes:
                return self.nodes["file:" + path]
        hits = [n for n in self.nodes.values() if n.get("qual") == ref] or \
               [n for n in self.nodes.values() if n.get("name") == ref and n["kind"] != "folder"]
        return sorted(hits, key=lambda n: (n["kind"] == "method", n["file"]))[0] if hits else None

    def brief(self, n: dict) -> dict:
        out = {"id": n["id"], "kind": n["kind"], "name": n.get("qual") or n["name"], "file": n["file"]}
        if n.get("line"):
            out["line"] = n["line"]
        return out

    def code(self, n: dict, max_lines: int = 120) -> str:
        if n["kind"] in ("folder",):
            return ""
        try:
            lines = (self.root / n["file"]).read_text(errors="replace").splitlines()
        except OSError:
            return ""
        if n["kind"] == "file":
            return "\n".join(lines[:60])[:6000]
        part = lines[n["line"] - 1: n["end"]]
        text = "\n".join(part[:max_lines])
        if len(part) > max_lines:
            text += f"\n… {len(part) - max_lines} more lines"
        return text[:8000]

    def related(self, n: dict, kind: str, direction: str) -> list[dict]:
        edges = self.into[n["id"]] if direction == "in" else self.out[n["id"]]
        out = []
        for e in edges:
            if e["kind"] != kind:
                continue
            other = self.nodes[e["s"] if direction == "in" else e["t"]]
            item = self.brief(other)
            if e.get("how"):
                item["matched_by"] = e["how"]
            out.append(item)
        return out[:40]

    def outline(self, f: dict) -> list[dict]:
        return [self.brief(self.nodes[e["t"]]) | {"end": self.nodes[e["t"]].get("end")}
                for e in self.out[f["id"]] if e["kind"] == "contains" and e["t"].startswith("sym:")] + \
               [self.brief(self.nodes[e2["t"]]) for e in self.out[f["id"]] if e["kind"] == "contains" and e["t"].startswith("sym:")
                for e2 in self.out[e["t"]] if e2["kind"] == "contains"]

    def detail(self, n: dict) -> dict:
        """What the page's side panel shows for one node."""
        d = {"node": n, "code": self.code(n)}
        if n["kind"] == "file":
            d["outline"] = self.outline(n)
            d["imports"] = self.related(n, "imports", "out")
            d["imported_by"] = self.related(n, "imports", "in")
            d["packages"] = self.graph.get("external", {}).get(n["file"], [])
        d["calls"] = self.related(n, "calls", "out")
        d["called_by"] = self.related(n, "calls", "in")
        if n["kind"] in ("class", "interface"):
            d["extends"] = self.related(n, "extends", "out")
            d["subclasses"] = self.related(n, "extends", "in")
        return d

    def run(self, name: str, args: dict) -> tuple[Any, list[str]]:
        """One chat tool. Returns the result for the model and the node ids it touched, for the page to light up."""
        if name == "search_symbols":
            words = [w.lower() for w in str(args.get("query", "")).split() if w]
            kind = args.get("kind") or "any"
            scored = []
            for n in self.nodes.values():
                if n["kind"] == "folder" or (kind != "any" and n["kind"] != kind):
                    continue
                hay = f"{n.get('qual') or n['name']} {n['file']}".lower()
                if words and all(w in hay for w in words):
                    exact = any(w == n["name"].lower() for w in words)
                    scored.append((not exact, n["kind"] == "file", len(hay), n))
            hits = [self.brief(s[3]) for s in sorted(scored, key=lambda s: s[:3])[:20]]
            return {"matches": hits, "total": len(scored)}, [h["id"] for h in hits]
        n = self.find(str(args.get("ref", "")))
        if n is None:
            return {"error": f"Nothing called {args.get('ref')!r}. Use search_symbols first."}, []
        if name == "get_node":
            return {**self.brief(n), "end": n.get("end"), "code": self.code(n)}, [n["id"]]
        if name == "callers_of":
            r = self.related(n, "calls", "in")
            return {"of": self.brief(n), "callers": r}, [n["id"]] + [x["id"] for x in r]
        if name == "callees_of":
            r = self.related(n, "calls", "out")
            return {"of": self.brief(n), "calls": r}, [n["id"]] + [x["id"] for x in r]
        if name == "imports_of":
            f = n if n["kind"] == "file" else self.nodes.get(f"file:{n['file']}", n)
            a, b = self.related(f, "imports", "out"), self.related(f, "imports", "in")
            return {"file": f["file"], "imports": a, "imported_by": b,
                    "packages": self.graph.get("external", {}).get(f["file"], [])}, [f["id"]] + [x["id"] for x in a + b]
        if name == "file_outline":
            f = n if n["kind"] == "file" else self.nodes.get(f"file:{n['file']}", n)
            o = self.outline(f)
            return {"file": f["file"], "symbols": o}, [f["id"]]
        if name == "subclasses_of":
            r = self.related(n, "extends", "in")
            return {"of": self.brief(n), "subclasses": r}, [n["id"]] + [x["id"] for x in r]
        return {"error": f"There is no tool called {name}."}, []


class CodeGraphService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, root: Path, lab_root: Path = ROOT):
        self.claude, self.spend, self.root, self.lab_root = claude, spend, root, lab_root
        self._cache: dict[str, GraphIndex] = {}
        self._lock = threading.Lock()

    # where a code base's files are, and its cached graph
    def _src(self, graph_id: str) -> Path:
        return self.lab_root if graph_id == LAB_ID else self.root / graph_id / "src"

    def _check_id(self, graph_id: str) -> str:
        if graph_id != LAB_ID and not re.fullmatch(r"[a-f0-9]{12}", graph_id or ""):
            raise ApiError(404, "not_found", "No such code base.")
        return graph_id

    def info(self) -> dict[str, Any]:
        sources = []
        if self.root.exists():
            for meta in sorted(self.root.glob("*/meta.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                try:
                    sources.append(json.loads(meta.read_text()))
                except (OSError, json.JSONDecodeError):
                    pass
        return {"sources": sources, "model": CLAUDE_MODEL, "tools": [{"name": t["name"], "description": t["description"]} for t in TOOLS],
                "limits": {"files": MAX_FILES, "archive_mb": MAX_ARCHIVE_BYTES // 2**20}}

    def _save(self, graph_id: str, label: str, graph: dict) -> dict[str, Any]:
        folder = self.root / graph_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "graph.json").write_text(json.dumps(graph))
        meta = {"id": graph_id, "label": label, "files": graph["files"], "counts": graph["counts"],
                "edge_counts": graph["edge_counts"], "took_s": graph["took_s"], "notes": graph["notes"], "at": int(time.time())}
        (folder / "meta.json").write_text(json.dumps(meta))
        with self._lock:
            self._cache[graph_id] = GraphIndex(graph, self._src(graph_id))
        return meta

    def analyse_lab(self) -> dict[str, Any]:
        """This lab's own code, read where it is (nothing is copied)."""
        return self._save(LAB_ID, "This lab's code", analyse(self.lab_root, use_git=True))

    def analyse_archive(self, label: str, data: bytes) -> dict[str, Any]:
        if len(data) > MAX_ARCHIVE_BYTES:
            raise ApiError(400, "too_big", f"Archives over {MAX_ARCHIVE_BYTES // 2**20} MB are not accepted.")
        graph_id = hashlib.sha256(data).hexdigest()[:12]
        src = self.root / graph_id / "src"
        if src.exists():
            shutil.rmtree(src)
        if safe_extract(data, src) == 0:
            raise ApiError(400, "no_source", "The archive has no Python, JavaScript or TypeScript files.")
        return self._save(graph_id, label, analyse(src))

    def analyse_upload(self, name: str, data_b64: str) -> dict[str, Any]:
        try:
            data = base64.b64decode(data_b64, validate=True)
        except ValueError:
            raise ApiError(400, "invalid_request", "The file must be sent as base64.") from None
        return self.analyse_archive(re.sub(r"[^\w. -]", "", name)[:80] or "upload.zip", data)

    def analyse_github(self, url: str, fetch: Callable[[str], bytes] | None = None) -> dict[str, Any]:
        label, data = download_github(url, fetch)
        return self.analyse_archive(label, data)

    def index(self, graph_id: str) -> GraphIndex:
        graph_id = self._check_id(graph_id)
        with self._lock:
            found = self._cache.get(graph_id)
        if found:
            return found
        path = self.root / graph_id / "graph.json"
        if not path.exists():
            if graph_id == LAB_ID:
                self.analyse_lab()
                return self._cache[LAB_ID]
            raise ApiError(404, "not_found", "That code base has not been analysed. Analyse it again.")
        idx = GraphIndex(json.loads(path.read_text()), self._src(graph_id))
        with self._lock:
            self._cache[graph_id] = idx
        return idx

    def graph(self, graph_id: str) -> dict[str, Any]:
        g = self.index(graph_id).graph
        return {"id": graph_id, "nodes": g["nodes"], "edges": g["edges"], "counts": g["counts"],
                "edge_counts": g["edge_counts"], "notes": g["notes"], "files": g["files"], "took_s": g["took_s"]}

    def node(self, graph_id: str, node_id: str) -> dict[str, Any]:
        idx = self.index(graph_id)
        n = idx.nodes.get(node_id)
        if n is None:
            raise ApiError(404, "not_found", "No such node.")
        return idx.detail(n)

    def ask(self, graph_id: str, question: str, history: list[dict], model: str | None) -> dict[str, Any]:
        """The question answered by a model that explores the graph through its tools."""
        idx = self.index(graph_id)
        model = model or CLAUDE_MODEL
        messages: list[dict] = []
        for h in history[-6:]:
            messages += [{"role": "user", "content": str(h.get("q", ""))[:2000]},
                         {"role": "assistant", "content": str(h.get("a", ""))[:4000] or "(no answer)"}]
        messages.append({"role": "user", "content": question})
        cost, steps, used = 0.0, [], []
        for _ in range(MAX_ROUNDS):
            try:
                response = self.claude.create(model=model, max_tokens=1500, system=SYSTEM, tools=TOOLS, messages=messages)
            except Exception as exc:
                raise to_api_error(exc) from exc
            cost += self.spend.charge(response, model) or 0.0
            uses = [b for b in response.content if getattr(b, "type", "") == "tool_use"]
            if not uses:
                return {"answer": text_of(response) or "(The model gave no answer.)", "steps": steps,
                        "used": list(dict.fromkeys(used)), "cost_usd": round(cost, 6), "model": model}
            messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) if hasattr(b, "model_dump") else b
                                                              for b in response.content]})
            results = []
            for u in uses:
                result, touched = idx.run(u.name, dict(u.input or {}))
                used += touched
                steps.append({"tool": u.name, "input": u.input, "found": len(touched)})
                results.append({"type": "tool_result", "tool_use_id": u.id, "content": json.dumps(result)[:12000]})
            messages.append({"role": "user", "content": results})
        return {"answer": "The model was still exploring after eight rounds of tools, so it stopped. Ask something "
                          "narrower.", "steps": steps, "used": list(dict.fromkeys(used)), "cost_usd": round(cost, 6),
                "model": model}
