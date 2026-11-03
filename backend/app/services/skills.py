"""Live Agent Skills runs (python/12_agent_skills.py), and downloads of the files they make."""
from __future__ import annotations

import mimetypes
import threading
from collections.abc import Iterator

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, skills_script as K
from .runs import Run, RunStreamer
from .spend import SpendTracker


class MadeFiles:
    """Files made by skill runs on this server. Only these may be downloaded through it."""

    def __init__(self) -> None:
        self._names: dict[str, str] = {}
        self._lock = threading.Lock()

    def add(self, file_id: str, name: str) -> None:
        with self._lock:
            self._names[file_id] = name

    def name(self, file_id: str) -> str | None:
        with self._lock:
            return self._names.get(file_id)


class SkillsService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer, files: MadeFiles):
        self.claude, self.spend, self.streamer, self.files = claude, spend, streamer, files

    def run(self, skill: str, upto: int, model: str | None) -> Iterator[str]:
        model = model or DEFAULT_MODEL
        task = K.TASKS[skill].format(upto=upto)
        skills = [{"type": "anthropic", "skill_id": skill, "version": "latest"}]
        run = Run()

        def work() -> None:
            run.publish({"type": "task", "task": task, "model": model, "skills": [skill]})
            result = K.run_with_skills(self.claude.client, model, skills, task, emit=run.publish,
                                       on_response=lambda resp: self.spend.charge(resp, model),
                                       cancelled=run.cancelled.is_set)
            run.publish({"type": "files", "files": self.register(result.file_ids), "cost": round(result.cost, 4),
                         "spent_usd": round(self.spend.spent_usd, 4)})

        return self.streamer.lines(run, work)

    def register(self, file_ids: list[str]) -> list[dict]:
        """Records files a run made, so they can be downloaded, and describes them for the page."""
        made = []
        for file_id in dict.fromkeys(file_ids):
            name, size = self.claude.file_info(file_id)
            self.files.add(file_id, name)
            made.append({"id": file_id, "name": name, "size_bytes": size})
        return made

    def download(self, file_id: str) -> tuple[str, str, bytes]:
        """(name, media type, content) of a file a skill made here."""
        name = self.files.name(file_id)
        if name is None:
            raise ApiError(404, "not_found", "Only files made by a skill run on this server can be downloaded.")
        try:
            content = self.claude.file_bytes(file_id)
        except Exception as exc:
            raise to_api_error(exc) from exc
        return name, mimetypes.guess_type(name)[0] or "application/octet-stream", content
