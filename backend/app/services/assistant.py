"""The assistant page (/assistant): a general chat assistant that plans, works in the lab's sandbox and makes files.

Each message starts a turn: the person's text and attachments are stored, the main agent (assistant_agent.Agent) plans
and works until it decides it is done, sub-agents run in parallel when it delegates, and every event is streamed to the
page and kept in the turn's log. The person chooses the model and effort per message; the whole history goes to the
new model (thinking blocks only to the model that wrote them), and a long chat is summarised before a model call
(compaction), never deleted. One turn runs per chat at a time; different chats run at once.

Stops: the run's budget for the whole tree of agents (ASSISTANT_RUN_BUDGET_USD by default, the page can change it per
message), the wall-clock ceiling (ASSISTANT_RUN_TIME_LIMIT_S), Stop, a refusal or an error. There is no step limit:
the model decides when it is done.

Commands run only in a contained sandbox (19_coding_agent.SANDBOX); with none, or with the Docker sandbox not running,
a message is refused with what to start. The sandbox can reach the internet (the person chose that); every command
that looks like it does is flagged in the log.
"""
from __future__ import annotations

import base64
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..core.errors import ApiError
from ..settings import MODELS, Settings
from ..shared import ModelUnavailable, NeedsClaude, coding_script as C, is_local, local_status, sandbox_skills as S
from .assistant_agent import (Agent, Stopped, Turn, cheapest_claude, compaction_cut, efforts_for, make_previews,
                              new_turn_id, provider, summary_of, window_for)
from . import assistant_store as store_rules
from .assistant_store import (DEFAULT_TITLE, IMAGE_TYPES, MAX_FILE_BYTES, MAX_FILES, MAX_TITLE, UPLOAD_EXTENSIONS,
                              ChatStore, content_id, file_content_id, now_iso, public_file, safe_name)
from .conversation_store import Conflict, Step
from .model_failover import estimate_tokens, latest_summary, visible
from .model_failover import build_messages as _build
from .assistant_brands import BrandKits
from .assistant_mcp import McpServers
from .assistant_router import (CLASSIFIER_MAX_TOKENS, CLASSIFIER_PROMPT, CLASSIFIER_SCHEMA, AutoState, Route, Router,
                               RoutingLog, needs_of, parse_classifier, record_for, rules)
from .runs import Run, RunRegistry, RunStreamer
from .spend import RunBudget, SpendTracker

MAX_TEXT = 20_000
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # an attached picture is also shown to the model, up to Claude's limit
START_GRACE_S = 30.0  # a claim whose work never began (the page left before the stream started) lapses after this
PREVIEW_TIMEOUT_S = 180
MIN_BUDGET, MAX_BUDGET = 0.05, 20.0
NAMES = {"claude-haiku-5-5": "Claude Haiku 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5",
         "claude-opus-5-5": "Claude Opus 5.5"}


class AssistantService:
    def __init__(self, claude: Any, spend: SpendTracker, registry: RunRegistry, streamer: RunStreamer,
                 store: ChatStore, settings: Settings, mcp: McpServers, brands: BrandKits | None = None):
        self.claude, self.spend, self.registry, self.streamer, self.store = claude, spend, registry, streamer, store
        self.mcp = mcp  # the person's remote MCP servers, for every agent in a turn
        self.routing = RoutingLog(store.folder / "routing.jsonl")  # routed turns and their savings
        self._local_seen: tuple[float, bool] = (0.0, True)  # when the local server was last checked, and if it was up
        # Company deck templates and style notes, kept on this machine only (generated/ is gitignored).
        self.brands = brands if brands is not None else BrandKits(settings.generated_dir / "brands")
        self.run_budget_usd = settings.assistant_run_budget_usd
        self.max_parallel = settings.assistant_max_parallel_agents
        self.time_limit_s = settings.assistant_run_time_limit_s
        self.compact_at = settings.assistant_compact_at_tokens
        self.sandbox: Any = None  # tests put a fake here; None means the coding agent's SANDBOX
        self.sandbox_check: Any = None  # tests put a no-op here; None means sandbox_skills.check_running
        self._claims: dict[str, dict[str, Any]] = {}  # chat id -> the run working on it
        self._approvals: dict[str, dict[str, Any]] = {}  # approval id -> waiter
        self._uploading: dict[str, int] = {}  # chat id -> uploads being written now
        self._lock = threading.Lock()

    # ----- models and the sandbox -----
    def models(self) -> list[str]:
        return list(MODELS)

    def box(self) -> Any:
        box = self.sandbox if self.sandbox is not None else C.SANDBOX
        if box is None:
            raise ApiError(409, "no_sandbox", "No sandbox is set up for the assistant's commands. Start the Docker "
                                              "sandbox with ./tools/sandbox.sh and set LLM_LAB_SANDBOX=docker in .env.")
        return box

    def sandbox_status(self) -> dict[str, Any]:
        try:
            box = self.box()
            (self.sandbox_check or S.check_running)()
            return {"available": True, "kind": getattr(box, "kind", "sandbox"), "message": ""}
        except ApiError as exc:
            return {"available": False, "kind": None, "message": exc.message}
        except (NeedsClaude, ModelUnavailable, OSError) as exc:
            return {"available": False, "kind": getattr(self.sandbox or C.SANDBOX, "kind", None), "message": str(exc)}

    def _need_sandbox(self) -> None:
        status = self.sandbox_status()
        if not status["available"]:
            raise ApiError(409, "no_sandbox", status["message"] or "The sandbox is not available.")

    def call_model(self, params: dict[str, Any], on_text: Any, cancelled: threading.Event,
                   progress: dict[str, Any] | None = None) -> Any:
        """One streamed model call through the lab's gateway (failover included). Text reaches the page as it is
        written. Stop is checked on every stream event, not only on text, so a long thinking or tool-input stream stops
        at once (leaving the `with` closes the stream). `progress` records that the stream opened, the characters
        streamed and the input tokens reported, so a call that ends part-way can be charged."""
        progress = progress if progress is not None else {"opened": False, "chars": 0, "input_tokens": 0}
        with self.claude.stream(**params) as s:
            progress["opened"] = True
            for event in s:
                if cancelled.is_set():
                    raise Stopped("stopped", "Stopped by the person.")
                kind = getattr(event, "type", "")
                if kind == "message_start":
                    usage = getattr(getattr(event, "message", None), "usage", None)
                    progress["input_tokens"] = getattr(usage, "input_tokens", 0) or 0
                elif kind == "content_block_delta":
                    delta = event.delta
                    piece = (getattr(delta, "text", None) or getattr(delta, "thinking", None)
                             or getattr(delta, "partial_json", None) or "")
                    progress["chars"] += len(piece)
                    if getattr(delta, "type", "") == "text_delta":
                        on_text(delta.text)
            return s.get_final_message()

    # ----- info and chats -----
    def info(self) -> dict[str, Any]:
        models = [{"id": m, "name": NAMES.get(m, m), "provider": provider(m), "context_window": window_for(m),
                   "efforts": efforts_for(m)} for m in self.models()]
        return {"models": models, "default_model": self._default_model(),
                "efforts_all": ["low", "medium", "high", "xhigh", "max"], "run_budget_usd": self.run_budget_usd,
                "max_parallel_agents": self.max_parallel, "run_time_limit_s": self.time_limit_s,
                "compact_at_tokens": self.compact_at, "sandbox": self.sandbox_status(),
                "upload": {"max_files": MAX_FILES, "max_file_bytes": MAX_FILE_BYTES, "extensions": UPLOAD_EXTENSIONS},
                "brands": self.brands.list()}

    def _default_model(self) -> str:
        models = self.models()
        return "claude-sonnet-5-5" if "claude-sonnet-5-5" in models else models[0]

    def _claim(self, chat_id: str, run_id: str, kind: str, started: bool = False) -> bool:
        """Takes the chat for one piece of work (a turn, a delete, a compaction, retention), under the lock, so two
        cannot act on one chat at once. False when something else holds it."""
        with self._lock:
            held = self._claims.get(chat_id)
            if held and (held["started"] or time.monotonic() - held["at"] < START_GRACE_S):
                return False
            self._claims[chat_id] = {"run_id": run_id, "kind": kind, "started": started, "at": time.monotonic()}
            return True

    def _release(self, chat_id: str, run_id: str) -> None:
        with self._lock:
            if self._claims.get(chat_id, {}).get("run_id") == run_id:
                del self._claims[chat_id]

    def _prune(self) -> None:
        """Retention: deletes the oldest chats beyond MAX_CHATS, each only if it can be claimed, so a chat in use (or
        being deleted or compacted) is skipped, never deleted under it."""
        for chat_id in self.store.beyond():
            token = new_turn_id()
            if self._claim(chat_id, token, "prune", started=True):
                try:
                    self.store.delete(chat_id)
                except ApiError:
                    pass  # already gone
                finally:
                    self._release(chat_id, token)

    def _running(self) -> set[str]:
        with self._lock:
            now = time.monotonic()
            return {cid for cid, c in self._claims.items() if c["started"] or now - c["at"] < START_GRACE_S}

    def _summary(self, meta: dict[str, Any], running: set[str]) -> dict[str, Any]:
        return {"id": meta["id"], "title": meta["title"], "created_at": meta["created_at"],
                "updated_at": meta["updated_at"], "model": meta["settings"].get("model"),
                "status": "running" if meta["id"] in running else "idle",
                "cost_usd": round(sum(t["assistant"].get("cost_usd", 0) for t in meta["turns"]), 6)}

    def list_chats(self) -> list[dict[str, Any]]:
        running = self._running()
        return [self._summary(m, running) for m in self.store.list()]

    def create_chat(self) -> dict[str, Any]:
        settings = {"model": self._default_model(), "effort": "medium", "run_budget_usd": self.run_budget_usd,
                    "approve_plans": False, "mcp_servers": [s["id"] for s in self.mcp.all() if s["enabled"]],
                    "deck_brand": ""}
        meta = self.store.create(settings)
        self._prune()
        return self._summary(meta, set())

    def get_chat(self, chat_id: str) -> dict[str, Any]:
        self._recover(chat_id)
        meta = self.store.read(chat_id)
        running = self._running()
        return {**self._summary(meta, running), "settings": meta["settings"],
                "uploads": [public_file(chat_id, u) for u in meta["uploads"]],
                "turns": [self._public_turn(chat_id, meta, t) for t in meta["turns"]]}

    def _public_turn(self, chat_id: str, meta: dict[str, Any], t: dict[str, Any]) -> dict[str, Any]:
        uploads = {u["id"]: u for u in meta["uploads"]}
        a = t["assistant"]
        return {"id": t["id"], "created_at": t["created_at"],
                "user": {"text": t["user"]["text"],
                         "attachments": [public_file(chat_id, uploads[i]) for i in t["user"]["attachments"] if i in uploads]},
                "assistant": {**{k: v for k, v in a.items() if k != "files"},
                              "files": [public_file(chat_id, meta["files"][i]) for i in a.get("files", [])
                                        if i in meta["files"]]},
                "log_count": self.store.log_count(chat_id, t["id"])}

    def rename(self, chat_id: str, title: str) -> dict[str, Any]:
        title = " ".join((title or "").split())[:MAX_TITLE]
        if not title:
            raise ApiError(400, "invalid_request", "A title cannot be empty.")
        meta = self.store.update(chat_id, lambda m: m.__setitem__("title", title))
        return self._summary(meta, self._running())

    def delete_chat(self, chat_id: str) -> None:
        self.store.read(chat_id)
        token = new_turn_id()
        with self._lock:  # one step: no upload can start between the check and the claim
            if self._uploading.get(chat_id):
                raise ApiError(409, "running", "Files are being added to this chat. Try again in a moment.")
            held = self._claims.get(chat_id)
            if held and (held["started"] or time.monotonic() - held["at"] < START_GRACE_S):
                raise ApiError(409, "running", "This chat is working on a message. Stop it first.")
            self._claims[chat_id] = {"run_id": token, "kind": "delete", "started": True, "at": time.monotonic()}
        try:
            self.store.delete(chat_id)
        finally:
            self._release(chat_id, token)

    def turn_log(self, chat_id: str, turn_id: str) -> list[dict[str, Any]]:
        self.store.read(chat_id)
        return self.store.read_log(chat_id, turn_id)

    def upload(self, chat_id: str, files: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
        """Saves uploads in the chat's inputs/. Free. Refused while the chat is being deleted, and a delete waits for
        nothing: it is refused while an upload is being written, so no upload lands in a folder about to go."""
        self.store.read(chat_id)
        with self._lock:
            if self._claims.get(chat_id, {}).get("kind") == "delete":
                raise ApiError(409, "running", "This chat is being deleted.")
            self._uploading[chat_id] = self._uploading.get(chat_id, 0) + 1
        try:
            return self._upload(chat_id, files)
        finally:
            with self._lock:
                self._uploading[chat_id] -= 1
                if not self._uploading[chat_id]:
                    del self._uploading[chat_id]

    def _upload(self, chat_id: str, files: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
        if not files:
            raise ApiError(400, "invalid_request", "Choose at least one file.")
        if len(files) > MAX_FILES:
            raise ApiError(400, "invalid_request", f"At most {MAX_FILES} files at a time.")
        for name, data in files:
            stem, dot, ext = safe_name(name).rpartition(".")
            if not dot or not stem or ext.lower() not in UPLOAD_EXTENSIONS:
                raise ApiError(400, "invalid_request", f"{safe_name(name)}: this kind of file is not accepted. "
                                                       f"Accepted: {', '.join(UPLOAD_EXTENSIONS)}.")
            if len(data) > MAX_FILE_BYTES:
                raise ApiError(413, "too_large", f"{safe_name(name)} is over {MAX_FILE_BYTES // 2**20} MB.")
            if not data:
                raise ApiError(400, "invalid_request", f"{safe_name(name)} is empty.")
        return [public_file(chat_id, r) for r in self.store.add_uploads(chat_id, files, store_rules.MAX_CHAT_UPLOAD_BYTES)]

    def media(self, chat_id: str, file_id: str, preview: int | None = None) -> tuple[Path, str, bool]:
        """The file (or one of its preview pages), its media type, and whether a browser may show it inline."""
        record = self.store.find_file(chat_id, file_id)
        if record is None:
            raise ApiError(404, "not_found", "No such file.")
        if preview is None:
            rel, kind = record["path"], record["media_type"]
        else:
            pages = record.get("previews") or []
            if not 0 <= preview < len(pages):
                raise ApiError(404, "not_found", "No such preview.")
            rel, kind = (record["path"], record["media_type"]) if pages[preview] == "self" else \
                (f"workspace/{pages[preview]}", "image/png")
        path = self.store.file_path(chat_id, rel)
        if path is None:
            raise ApiError(404, "not_found", "That file is no longer there.")
        inline = kind.startswith("image/") or kind == "application/pdf"
        return path, kind, inline

    # ----- a turn -----
    def send(self, chat_id: str, text: str, attachments: list[str], model: str, effort: str, run_budget_usd: float,
             approve_plans: bool, mcp_servers: list[str] | None = None, deck_brand: str | None = None,
             auto: bool = False) -> Iterator[str]:
        """One message. With `auto`, the router picks the model and effort; a `model` (and `effort`) sent with it is
        the ceiling routing may not go above, and an empty `model` means no ceiling."""
        meta = self.store.read(chat_id)
        text = (text or "").strip()
        if not text:
            raise ApiError(400, "invalid_request", "Write a message first.")
        if len(text) > MAX_TEXT:
            raise ApiError(400, "invalid_request", f"A message can be at most {MAX_TEXT:,} characters.")
        if not (auto and not model) and model not in self.models():
            raise ApiError(400, "invalid_request", f"model must be one of: {', '.join(self.models())}")
        effort = effort or ""
        if model and effort and effort not in efforts_for(model):
            raise ApiError(400, "invalid_request", f"{model} does not take effort {effort}. It takes: "
                                                   f"{', '.join(efforts_for(model)) or 'none'}.")
        if not MIN_BUDGET <= float(run_budget_usd) <= MAX_BUDGET:
            raise ApiError(400, "invalid_request", f"The run budget must be between ${MIN_BUDGET} and ${MAX_BUDGET}.")
        uploads = {u["id"]: u for u in meta["uploads"]}
        unknown = [a for a in attachments if a not in uploads]
        if unknown:
            raise ApiError(400, "invalid_request", "An attachment is not one of this chat's files. Upload it again.")
        if mcp_servers is None:  # not sent: the chat keeps what it had
            mcp_servers = list(meta["settings"].get("mcp_servers", []))
        known = {s["id"] for s in self.mcp.all()}
        if any(s not in known for s in mcp_servers):
            raise ApiError(400, "invalid_request", "An MCP server in this message is not one of yours. Reload the page.")
        if deck_brand is None:  # not sent: the chat keeps its brand (or the house style)
            deck_brand = str(meta["settings"].get("deck_brand", "") or "")
        if deck_brand and self.brands.get(deck_brand) is None:
            raise ApiError(400, "invalid_request", "That deck style is not one of the brand kits on this machine.")
        self._need_sandbox()
        run = Run(APPROVAL_TIMEOUT_FALLBACK)
        if not self._claim(chat_id, run.id, "turn"):
            raise ApiError(409, "running", "This chat is busy: it is working on a message, or being deleted or "
                                           "compacted. Wait for it, or stop it.")
        try:
            meta = self.store.read(chat_id)  # deleted between the first read and the claim: a clean 404
        except ApiError:
            self._release(chat_id, run.id)
            raise
        # The model that answered last time (routing may have chosen it), so a change shows as a model switch.
        previous = (meta["turns"][-1]["assistant"].get("model") or meta["settings"].get("model")) if meta["turns"] else None
        kept = meta["settings"]
        settings = {"model": model or kept.get("model") or self._default_model(),
                    "effort": effort if model else kept.get("effort", "medium"),
                    "run_budget_usd": float(run_budget_usd),
                    "approve_plans": bool(approve_plans), "mcp_servers": list(dict.fromkeys(mcp_servers)),
                    "deck_brand": deck_brand, "auto": bool(auto),
                    # With Auto, a model sent with the message is the ceiling; none sent means no ceiling.
                    "auto_ceiling": bool(auto and model)}

        def work() -> None:
            with self._lock:
                if self._claims.get(chat_id, {}).get("run_id") == run.id:
                    self._claims[chat_id]["started"] = True
            try:
                self._turn(chat_id, run, text, [uploads[a] for a in attachments], settings, previous)
            finally:
                self._release(chat_id, run.id)

        return self.streamer.lines(run, work)

    def _turn(self, chat_id: str, run: Run, text: str, attachments: list[dict[str, Any]], settings: dict[str, Any],
              previous: str | None) -> None:
        meta = self.store.read(chat_id)
        conv = self.store.steps.load(meta["conv_id"])
        model = settings["model"]
        turn_id = new_turn_id()
        last = max((s.turn for s in conv.steps), default=0)
        t = Turn(self, chat_id, turn_id, meta["conv_id"], run, model, settings["effort"], settings["approve_plans"],
                 RunBudget(settings["run_budget_usd"], min(0.05, settings["run_budget_usd"] / 4)),
                 time.monotonic() + self.time_limit_s, self.max_parallel, etag=conv.etag, conv_turn=last + 1)
        record = {"id": turn_id, "created_at": now_iso(),
                  "user": {"text": text, "attachments": [a["id"] for a in attachments]},
                  "assistant": {"text": "", "model": model, "models_used": [], "plan": None, "files": [],
                                "cost_usd": 0.0, "stopped": "running"}}

        def start(m: dict[str, Any]) -> None:
            m["settings"] = settings
            m["turns"].append(record)
        self.store.update(chat_id, start)
        main: Agent | None = None
        stopped, error, reply = "finished", None, ""

        def said() -> str:
            return "\n\n".join(x for x in (main.texts if main else []) if x)
        # From here on the turn is stored as running, so everything, set-up included, ends through the same path:
        # a failure anywhere still stores the turn as an error and sends done.
        try:
            t.emit({"type": "turn", "turn_id": turn_id})
            # The chosen brand kit goes into inputs/brand/ (or is cleared from it) before the agent starts.
            kit = self.brands.install(settings.get("deck_brand", ""), self.store.workspace(chat_id))
            t.append("user", "user", self._user_content(chat_id, text, attachments, BrandKits.note(kit) if kit else ""))
            t.mcp_defs, t.mcp_names, notes = self.mcp.tools_for(settings["mcp_servers"])
            for note in notes:
                t.emit({"type": "note", "agent": "main", "text": note})
            if settings.get("auto"):
                self._route(t, text, attachments, meta, settings)
            if previous and previous != t.model:
                t.emit({"type": "model_switch", "from": previous, "to": t.model})
            main = Agent(t, "main", self.store.workspace(chat_id))
            reply = main.run()
        except Stopped as exc:
            stopped, reply = exc.reason, said()
            if exc.reason in ("error", "refused", "budget", "time"):
                error = exc.message
        except ApiError as exc:
            stopped, error, reply = "error", exc.message, said()
        except Exception as exc:  # noqa: BLE001  (an API error part-way through, a file that vanished): still stored
            stopped, error, reply = "error", f"{type(exc).__name__}: {exc}", said()
        if error and stopped == "error":
            t.emit({"type": "error", "message": error})
        if stopped == "finished" and t.plan:
            open_steps = [x["text"] for x in t.plan["steps"] if x["status"] not in ("done", "skipped")]
            if open_steps:  # shown as they are: the agent's own ticks, never marked done on its behalf
                t.emit({"type": "note", "agent": "main",
                        "text": f"The turn finished, but the plan still has {len(open_steps)} of "
                                f"{len(t.plan['steps'])} steps not marked done: " + "; ".join(open_steps[:5])})
        try:
            self._previews(t)
        except Exception as exc:  # noqa: BLE001  (previews are a nicety: the files are there to download)
            t.emit({"type": "note", "agent": "main", "text": f"Page previews could not be made: {exc}"})
        if len(meta["turns"]) == 0 and meta["title"] == DEFAULT_TITLE:
            self._title(t, text, stopped)

        def finish(m: dict[str, Any]) -> None:
            for r in m["turns"]:
                if r["id"] == turn_id:
                    r["assistant"] = {"text": reply, "model": t.model, "models_used": t.models_used, "plan": t.plan,
                                      "files": list(t.files), "cost_usd": round(t.cost, 6), "stopped": stopped,
                                      **({"error": error} if error else {}),
                                      **({"route": self._route_record(t)} if t.auto else {})}
        self.store.update(chat_id, finish)
        if t.auto:
            try:
                self.routing.append(record_for(chat_id, turn_id, t.auto, t.cost - t.unrouted_cost))
            except OSError:
                pass  # the savings record is a report: never a reason to fail the turn
        t.emit({"type": "done", "stopped": stopped, "cost_usd": round(t.cost, 6), "text": reply})

    def _user_content(self, chat_id: str, text: str, attachments: list[dict[str, Any]],
                      brand_note: str = "") -> list[dict[str, Any]]:
        """The person's message as stored: their text, the attached files' paths, and small pictures themselves so
        the model can see them."""
        content: list[dict[str, Any]] = []
        if brand_note:
            content.append({"type": "text", "text": brand_note})
        if attachments:
            listed = "\n".join(f"- inputs/{Path(a.get('source', a['path'])).name} ({a['media_type']}, {a['size']:,} bytes)"
                               for a in attachments)
            content.append({"type": "text", "text": f"Attached files, in your inputs/ folder:\n{listed}"})
        for a in attachments:
            if a["media_type"] in IMAGE_TYPES and a["size"] <= MAX_IMAGE_BYTES:
                path = self.store.file_path(chat_id, a["path"])
                if path is not None:
                    content.append({"type": "image", "source": {"type": "base64", "media_type": a["media_type"],
                                                                "data": base64.b64encode(path.read_bytes()).decode()}})
        content.append({"type": "text", "text": text})
        return content

    def _previews(self, t: Turn) -> None:
        """Page images for the office files and PDFs this turn made; each file is sent again with its previews."""
        if t.run.cancelled.is_set():
            return
        meta = self.store.read(t.chat_id)
        root = self.store.workspace(t.chat_id)
        for file_id in list(t.files):
            rec = meta["files"].get(file_id)
            left = int(t.deadline - time.monotonic())
            source = (rec or {}).get("source", "")
            if rec is None or rec.get("previews") or left < 10 or not source.startswith("workspace/"):
                continue
            current = self.store.file_path(t.chat_id, source)
            if current is None or current.stat().st_size > store_rules.MAX_OUTPUT_FILE_BYTES \
                    or file_content_id(source, current) != file_id:
                continue  # changed again since: the newer version has its own id and its own previews
            try:
                pages = make_previews(self.box(), root, source[len("workspace/"):], file_id,
                                      min(PREVIEW_TIMEOUT_S, left))
            except ApiError:
                return
            if pages and (updated := self.store.set_previews(t.chat_id, file_id, pages)):
                t.emit({"type": "file", "agent": updated.get("agent", "main"), "file": public_file(t.chat_id, updated)})

    def _title(self, t: Turn, text: str, stopped: str) -> None:
        """A short title from the first message, by the cheapest Claude model; the message's start if that fails, or
        without a call at all when the person pressed Stop or the money is spent."""
        title = " ".join(text.split())[:60]
        reserved = None
        if stopped not in ("stopped", "budget") and not t.run.cancelled.is_set() and not self.spend.over_budget:
            reserved = t.budget.reserve()
        if reserved is not None:
            cost = None
            try:
                model = cheapest_claude(self.models())
                message = self.claude.create(model=model, max_tokens=40, messages=[{
                    "role": "user", "content": "Write a title of at most six words for a chat that starts with this "
                                               f"message. Reply with the title only.\n\n{text[:2000]}"}])
                cost = t.charge(message, model, routed=False)
                made = " ".join("".join(getattr(b, "text", "") for b in message.content
                                        if getattr(b, "type", "") == "text").split()).strip(" \"'.")
                title = made[:MAX_TITLE] or title
            except Exception:  # noqa: BLE001  (no Claude key, a rate limit): the message's start will do
                pass
            finally:
                t.budget.settle(reserved, cost)
        title = title or DEFAULT_TITLE
        self.store.update(t.chat_id, lambda m: m.__setitem__("title", title))
        t.emit({"type": "title", "title": title})

    # ----- compaction -----
    def compact(self, t: Turn, reason: str = "auto") -> bool:
        """Summarises the oldest turns into one summary step (nothing is deleted). False when there is nothing to cut."""
        conv = self.store.steps.load(t.conv_id)
        did = self._compact_steps(t.conv_id, conv, t.model, t)
        return did is not None

    def _compact_steps(self, conv_id: str, conv: Any, model: str, t: Turn | None) -> dict[str, Any] | None:
        summary, vis = visible(conv.steps)
        cut = compaction_cut(vis, 2)
        if cut is None:
            return None
        head = vis[:cut]
        before = estimate_tokens(_build(conv.steps, _Target(model)))
        compact_model = cheapest_claude(self.models())
        reserved = t.budget.reserve() if t else 0.0
        if t and reserved is None:
            raise Stopped("budget", "The run's budget is used up.")
        try:
            text, message = summarise(self, [*([summary] if summary else []), *head], compact_model)
        except BaseException:
            if t:
                t.budget.settle(reserved, None)
            raise
        cost = t.charge(message, compact_model) if t else (self.spend.charge(message, compact_model) or 0.0)
        if t:
            t.budget.settle(reserved, cost)
        if not text:
            return None  # an empty summary is never used: the conversation is sent as it is
        step = Step(max(s.turn for s in conv.steps), 0, "summary", "user",
                    [{"type": "text", "text": f"Summary of the conversation so far:\n{text}"}], model=compact_model,
                    created_at=now_iso(), covers_from=head[0].key, covers_until=head[-1].key)
        # A summary takes the next free step number in the newest turn, so it sorts after what it covers.
        last = max((s for s in conv.steps), key=lambda s: (s.turn, s.step))
        step.turn, step.step = last.turn, last.step + 1
        if step.step > 99:
            step.turn, step.step = last.turn + 1, 0
        etag = self.store.steps.append_step(conv_id, step, conv.etag)
        if t:
            t.etag = etag
            if step.turn >= t.conv_turn:
                t.conv_turn, t.conv_step = step.turn, step.step
        after = estimate_tokens(_build(self.store.steps.load(conv_id).steps, _Target(model)))
        event = {"type": "compaction", "covers_until": head[-1].key, "tokens_before": before, "tokens_after": after,
                 "model": compact_model}
        if t:
            t.emit(event)
        return event

    def compact_now(self, chat_id: str) -> dict[str, Any]:
        meta = self.store.read(chat_id)
        token = new_turn_id()
        if not self._claim(chat_id, token, "compact", started=True):
            raise ApiError(409, "running", "This chat is busy. Compact it when the turn has finished.")
        try:
            return self._compact_now(chat_id, meta)
        finally:
            self._release(chat_id, token)

    def _compact_now(self, chat_id: str, meta: dict[str, Any]) -> dict[str, Any]:
        conv = self.store.steps.load(meta["conv_id"])
        model = meta["settings"].get("model") or self._default_model()
        before = estimate_tokens(_build(conv.steps, _Target(model)))
        try:
            event = self._compact_steps(meta["conv_id"], conv, model, None)
        except Conflict:  # another Compact now got there first
            raise ApiError(409, "conflict", "The chat changed while it was being compacted. Try again.") from None
        if event is None:
            return {"compacted": False, "covers_until": latest_summary(conv.steps).covers_until
                    if latest_summary(conv.steps) else None, "tokens_before": before, "tokens_after": before}
        return {"compacted": True, "covers_until": event["covers_until"], "tokens_before": event["tokens_before"],
                "tokens_after": event["tokens_after"]}

    def _recover(self, chat_id: str) -> None:
        """A turn left "running" with no run behind it (the server stopped part-way) is closed as an error, and any
        tool call it left unanswered gets an interrupted result, so the chat can carry on."""
        token = new_turn_id()
        # The whole repair holds the chat, so a send cannot start a live turn in the middle of it (and have that turn
        # closed as an error), and two tabs reading the chat cannot both repair it.
        if not self._claim(chat_id, token, "recover", started=True):
            return
        try:
            meta = self.store.read(chat_id)
            if not any(t["assistant"].get("stopped") == "running" for t in meta["turns"]):
                return
            from .model_failover import pending_tool_uses
            for _ in range(3):
                conv = self.store.steps.load(meta["conv_id"])
                pending = pending_tool_uses(conv.steps)
                if not pending:
                    break
                last = max(conv.steps, key=lambda s: (s.turn, s.step))
                step = Step(last.turn if last.step < 99 else last.turn + 1, last.step + 1 if last.step < 99 else 1,
                            "tool", "user", [{"type": "tool_result", "tool_use_id": b["id"], "is_error": True,
                                              "content": "Interrupted: the server stopped before this tool ran."}
                                             for b in pending], created_at=now_iso(), tool="interrupted")
                try:
                    self.store.steps.append_step(meta["conv_id"], step, conv.etag)
                    break
                except Conflict:  # written meanwhile: read it again and see what is still unanswered
                    continue

            def close(m: dict[str, Any]) -> None:
                for t in m["turns"]:
                    if t["assistant"].get("stopped") == "running":
                        t["assistant"].update(stopped="error", error="The server stopped during this turn.")
            self.store.update(chat_id, close)
        finally:
            self._release(chat_id, token)

    # ----- the plan approval and Stop -----
    def wait_for_plan(self, t: Turn, plan: dict[str, Any]) -> dict[str, Any]:
        """Holds the turn until the person approves, edits or rejects the first plan. No answer in time is a no."""
        approval_id = new_turn_id()
        waiter = {"run_id": t.run.id, "event": threading.Event(), "decision": "reject", "steps": None, "note": ""}
        with self._lock:
            self._approvals[approval_id] = waiter
        t.emit({"type": "plan_approval", "approval_id": approval_id, "plan": plan})
        deadline = time.monotonic() + APPROVAL_TIMEOUT_S
        try:
            while not waiter["event"].wait(0.5):
                if t.run.cancelled.is_set():
                    raise Stopped("stopped", "Stopped by the person.")
                if time.monotonic() > deadline:
                    return {"decision": "reject", "note": "nobody answered within ten minutes"}
            return {"decision": waiter["decision"], "steps": waiter["steps"], "note": waiter["note"]}
        finally:
            with self._lock:
                self._approvals.pop(approval_id, None)

    def wait_for_tool(self, t: Turn, agent: str, info: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        """Holds one MCP call until the person says yes or no. No answer in ten minutes, or Stop, is a no."""
        approval_id = new_turn_id()
        waiter = {"run_id": t.run.id, "event": threading.Event(), "decision": "reject", "steps": None, "note": ""}
        with self._lock:
            self._approvals[approval_id] = waiter
        t.emit({"type": "tool_approval", "approval_id": approval_id, "agent": agent, "server": info["server"],
                "tool": info["tool"], "input": args})
        deadline = time.monotonic() + APPROVAL_TIMEOUT_S
        try:
            while not waiter["event"].wait(0.5):
                if t.run.cancelled.is_set():
                    raise Stopped("stopped", "Stopped by the person.")
                if time.monotonic() > deadline:
                    return {"decision": "reject", "note": "nobody answered within ten minutes"}
            return {"decision": waiter["decision"], "note": waiter["note"]}
        finally:
            with self._lock:
                self._approvals.pop(approval_id, None)

    def approve(self, run_id: str, approval_id: str, decision: str, steps: list[dict[str, Any]] | None,
                note: str) -> None:
        if decision not in ("approve", "reject"):
            raise ApiError(400, "invalid_request", "decision is approve or reject.")
        if steps is not None:
            if not 1 <= len(steps) <= 30 or any(not str(s.get("text", "")).strip() for s in steps):
                raise ApiError(400, "invalid_request", "An edited plan needs 1 to 30 steps, each with text.")
            steps = [{"text": str(s["text"]).strip()[:300], "status": s.get("status") if s.get("status") in
                      ("todo", "doing", "done", "skipped") else "todo"} for s in steps]
        with self._lock:  # taken out as it is answered, so a second answer finds nothing waiting
            waiter = self._approvals.get(approval_id)
            if waiter is None or waiter["run_id"] != run_id:
                raise ApiError(404, "not_found", "Nothing is waiting for that approval.")
            del self._approvals[approval_id]
            waiter.update(decision=decision, steps=steps if decision == "approve" else None, note=(note or "")[:1000])
            waiter["event"].set()

    def stop(self, run_id: str) -> None:
        """Stops one of this page's turns. Any other run id (another lab's, or one that has finished) is a 404."""
        with self._lock:
            ours = any(c["run_id"] == run_id and c.get("kind") == "turn" for c in self._claims.values())
        run = self.registry.get(run_id) if ours else None
        if run is None:
            raise ApiError(404, "not_found", "That run has already finished.")
        run.cancel()


    # ----- automatic routing -----
    def local_up(self) -> bool:
        """Whether the local model's server answers, checked at most every 30 seconds: Auto skips a local model that
        is set up but not running, rather than send it a message that would fail."""
        at, up = self._local_seen
        if time.monotonic() - at > 30:
            status = local_status()
            up = bool(status.get("running") and status.get("has_model"))
            self._local_seen = (time.monotonic(), up)
        return up

    def _router(self) -> Router:
        down = {m for m in self.models() if is_local(m)} if any(is_local(m) for m in self.models()) and \
            not self.local_up() else set()
        return Router(self.models(), unavailable=down)

    def _route(self, t: Turn, text: str, attachments: list[dict[str, Any]], meta: dict[str, Any],
               settings: dict[str, Any]) -> None:
        """Picks the turn's model and effort: from the signals when they settle it, else by one small classifier
        call. Sets them on the turn and says why in a route event, before the first model call."""
        router = self._router()
        needs = needs_of(attachments)
        ceiling = (settings["model"], settings.get("effort") or "") if settings.get("auto_ceiling") else None
        last = (meta["turns"][-1]["assistant"].get("route") or {}).get("tier") if meta["turns"] else None
        mcp_on = bool([s for s in self.mcp.all() if s["enabled"] and s["id"] in settings.get("mcp_servers", [])])
        decided = rules(text, attachments, last, mcp_on)
        by, cost = "rules", 0.0
        if decided is None:
            decided, cost = self._classify(t, text)
            by = "classifier"
        tier, reason = decided
        model, effort, used = router.pick(tier, needs, ceiling)
        if used != tier:
            reason += f"; no {tier} model fits here, so {used}"
        route = Route(used, model, effort, reason, by, round(cost, 6))
        t.model, t.effort = model, effort
        t.auto = AutoState(route, needs, ceiling)
        t.emit({"type": "route", "agent": "main", "model": model, "effort": effort, "tier": used, "reason": reason,
                "by": by, "classifier_cost_usd": route.classifier_cost_usd})

    def _classify(self, t: Turn, text: str) -> tuple[tuple[str, str], float]:
        """One small call to the cheapest Claude model: strict JSON {tier, reason}. Anything unreadable, or no Claude
        model to ask, means the middle tier."""
        claude = [m for m in self.models() if m.startswith("claude-")]
        if not claude:
            return ("standard", "no Claude model to classify with, so the middle tier"), 0.0
        model = cheapest_claude(claude)
        try:
            message = self.claude.create(
                model=model, max_tokens=CLASSIFIER_MAX_TOKENS,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": CLASSIFIER_SCHEMA}},
                messages=[{"role": "user", "content": CLASSIFIER_PROMPT + text[:4000]}])
        except Exception:  # noqa: BLE001  (rate limited, no key): routing still goes ahead
            return ("standard", "the classifier could not be asked, so the middle tier"), 0.0
        cost = t.charge(message, model)
        answer = parse_classifier("".join(getattr(b, "text", "") for b in message.content
                                          if getattr(b, "type", "") == "text"))
        return (answer or ("standard", "the classifier's answer could not be read, so the middle tier")), cost

    def escalate(self, t: Turn, reason: str) -> bool:
        """Moves the rest of a routed turn to the next tier up, once, within the ceiling. False when it cannot."""
        state = t.auto
        if state is None or state.escalated is not None:
            return False
        up = self._router().next_up(state, t.model)
        if up is None:
            return False
        state.escalated = (t.model, up[0])
        t.emit({"type": "escalate", "agent": "main", "from": t.model, "to": up[0], "effort": up[1], "tier": up[2],
                "reason": reason})
        t.model, t.effort = up[0], up[1]
        return True

    @staticmethod
    def _route_record(t: Turn) -> dict[str, Any]:
        r = t.auto.route
        return {"tier": r.tier, "model": r.model, "effort": r.effort, "reason": r.reason, "by": r.by,
                "escalated_to": t.auto.escalated[1] if t.auto.escalated else None}

    # ----- MCP servers -----
    def mcp_list(self) -> list[dict[str, Any]]:
        return [self.mcp.public(s) for s in self.mcp.all()]

    def mcp_add(self, name: str, url: str, token: str | None, ask_before_call: bool) -> dict[str, Any]:
        return self.mcp.public(self.mcp.add(name, url, token, ask_before_call))

    def mcp_update(self, server_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        return self.mcp.public(self.mcp.update(server_id, changes))

    def mcp_delete(self, server_id: str) -> None:
        self.mcp.delete(server_id)

    def mcp_check(self, server_id: str) -> dict[str, Any]:
        return self.mcp.public(self.mcp.check(server_id))

    # ----- recent files -----
    def recent_files(self, limit: int = 12) -> list[dict[str, Any]]:
        """The newest final files across chats: each turn's stored files (one per output path), newest first."""
        if not 1 <= limit <= 50:
            raise ApiError(400, "invalid_request", "limit is between 1 and 50.")
        out = []
        for meta in self.store.list():
            for turn in meta["turns"]:
                for file_id in turn["assistant"].get("files", []):
                    rec = meta["files"].get(file_id)
                    if rec:
                        out.append({"chat_id": meta["id"], "chat_title": meta["title"], "turn_id": turn["id"],
                                    "created_at": rec.get("created_at", ""), "file": public_file(meta["id"], rec)})
        return sorted(out, key=lambda r: r["created_at"], reverse=True)[:limit]


class _Target:
    """What build_messages needs to know of the model it builds for."""

    def __init__(self, model: str):
        self.model = model


def summarise(service: AssistantService, steps: list[Step], model: str) -> tuple[str, Any]:
    return summary_of(service, None, steps, model)


APPROVAL_TIMEOUT_FALLBACK = 120.0  # the Run's own permission prompts; the plan wait has its own ten minutes
APPROVAL_TIMEOUT_S = 600
