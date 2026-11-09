"""A permanent record of every conversation: each line written as it happens, kept for future reference.

The practice databases hold transcripts too, but the pages' reset buttons rebuild them, and MedAssist's portal chats
are not in a database at all. This archive is append-only and separate: one JSON Lines file per conversation, in
generated/transcripts/<kind>/<YYYY-MM>/<conversation id>.jsonl, each line written the moment it is said, so a call cut
off half way is still kept. Before a reset rebuilds a database, the old one is copied to databases/ with the time.

Each line: {"at", "kind", "conversation", "patient", "channel", "speaker", "text"}, or for a call's own events
{"at", ..., "event", "detail"}. kind is aftercare or medassist; channel is page or phone. On a real system these hold
health information: keep them only as long as your retention policy says, and only where they are protected.
"""
from __future__ import annotations

import json
import re
import shutil
import threading
from datetime import datetime
from pathlib import Path
from typing import Any


class TranscriptArchive:
    def __init__(self, root: Path):
        self.root = root
        self._lock = threading.Lock()

    def _file(self, kind: str, conversation: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9_-]", "_", conversation)[:64] or "unknown"
        found = list(self.root.glob(f"{kind}/*/{safe}.jsonl"))  # a conversation that began last month stays in one file
        return found[0] if found else self.root / kind / datetime.now().strftime("%Y-%m") / f"{safe}.jsonl"

    def _write(self, kind: str, conversation: str, entry: dict[str, Any]) -> None:
        with self._lock:
            path = self._file(kind, conversation)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"at": datetime.now().isoformat(timespec="seconds"), "kind": kind,
                                    "conversation": conversation, **entry}, ensure_ascii=False) + "\n")

    def line(self, kind: str, conversation: str, patient: str, channel: str, speaker: str, text: str,
             language: str = "en", english: str = "") -> None:
        """One thing said, by the patient, the caller, the agent or the line itself. Said in another language, it
        is kept as said, with the language and the English translation beside it."""
        if text:
            extra = {"language": language, "english": english} if language != "en" else {}
            self._write(kind, conversation, {"patient": patient, "channel": channel, "speaker": speaker,
                                             "text": text, **extra})

    def event(self, kind: str, conversation: str, patient: str, channel: str, event: str, detail: str = "") -> None:
        """Something that happened on a call: answered, emergency, identity confirmed, ended."""
        self._write(kind, conversation, {"patient": patient, "channel": channel, "event": event, "detail": detail})

    def keep_database(self, path: Path) -> Path | None:
        """A copy of a database about to be rebuilt, so a reset never loses a record."""
        if not path.exists():
            return None
        target = self.root / "databases" / f"{path.stem}-{datetime.now():%Y%m%d-%H%M%S}{path.suffix}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        return target

    def conversation(self, kind: str, conversation: str) -> list[dict[str, Any]]:
        """Everything kept for one conversation, in order."""
        path = self._file(kind, conversation)
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
