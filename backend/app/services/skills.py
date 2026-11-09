"""Live Agent Skills runs (python/12_agent_skills.py), and downloads of the files they make.

Claude runs skills in Anthropic's code execution container, and its files come back through the Files API. GPT and
the local model run them in the lab's own sandbox (python/sandbox_skills.py), and their files are on this server."""
from __future__ import annotations

import mimetypes
import threading
from collections.abc import Iterator
from pathlib import Path

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import CLAUDE_MODEL, sandbox_skills as S, skills_script as K
from .runs import Run, RunStreamer
from .spend import SpendTracker


class MadeFiles:
    """Files made by skill runs on this server. Only these may be downloaded through it."""

    def __init__(self) -> None:
        self._files: dict[str, tuple[str, Path | None]] = {}  # id -> (name, local path for a sandbox file)
        self._lock = threading.Lock()

    def add(self, file_id: str, name: str, path: Path | None = None) -> None:
        with self._lock:
            self._files[file_id] = (name, path)

    def name(self, file_id: str) -> str | None:
        with self._lock:
            return self._files.get(file_id, (None, None))[0]

    def path(self, file_id: str) -> Path | None:
        with self._lock:
            return self._files.get(file_id, (None, None))[1]


class SkillsService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer, files: MadeFiles):
        self.claude, self.spend, self.streamer, self.files = claude, spend, streamer, files

    def run(self, skill: str, upto: int, model: str | None) -> Iterator[str]:
        model = model or CLAUDE_MODEL
        task = K.TASKS[skill].format(upto=upto)
        run = Run()

        def work() -> None:
            sandbox = S.uses_sandbox(model)
            run.publish({"type": "task", "task": task, "model": model, "skills": [skill],
                         "where": "the lab's sandbox" if sandbox else "Anthropic's container"})
            charge = lambda resp: self.spend.charge(resp, model)  # noqa: E731
            if sandbox:
                S.prune()
                result = S.run_in_sandbox(self.claude.client, model, [skill], task, emit=run.publish,
                                          on_response=charge, cancelled=run.cancelled.is_set)
            else:
                skills = [{"type": "anthropic", "skill_id": skill, "version": "latest"}]
                result = K.run_with_skills(self.claude.client, model, skills, task, emit=run.publish,
                                           on_response=charge, cancelled=run.cancelled.is_set)
            run.publish({"type": "files", "files": self.register(result.file_ids, result.paths),
                         "cost": round(result.cost, 4), "spent_usd": round(self.spend.spent_usd, 4)})

        return self.streamer.lines(run, work)

    def register(self, file_ids: list[str], paths: dict[str, Path] | None = None) -> list[dict]:
        """Records files a run made, so they can be downloaded, and describes them for the page."""
        made = []
        for file_id in dict.fromkeys(file_ids):
            path = (paths or {}).get(file_id)
            if path is not None:
                name, size = path.name, path.stat().st_size if path.exists() else None
            else:
                name, size = self.claude.file_info(file_id)
            self.files.add(file_id, name, path)
            made.append({"id": file_id, "name": name, "size_bytes": size})
        return made

    def file_bytes(self, file_id: str) -> bytes:
        """The content of a made file, wherever it was made. A sandbox file is read as it is now."""
        path = self.files.path(file_id)
        return path.read_bytes() if path is not None else self.claude.file_bytes(file_id)

    def download(self, file_id: str) -> tuple[str, str, bytes]:
        """(name, media type, content) of a file a skill made here."""
        name = self.files.name(file_id)
        if name is None:
            raise ApiError(404, "not_found", "Only files made by a skill run on this server can be downloaded.")
        try:
            content = self.file_bytes(file_id)
        except FileNotFoundError as exc:
            raise ApiError(404, "not_found", f"{name} is no longer on the server. Run the skill again.") from exc
        except Exception as exc:
            raise to_api_error(exc) from exc
        return name, mimetypes.guess_type(name)[0] or "application/octet-stream", content
