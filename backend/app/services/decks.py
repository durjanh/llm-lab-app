"""The deck builder: a conversation with Claude that makes and revises a PowerPoint deck.

Each turn takes a request, optional source files and an optional template. The files are
uploaded to the Files API and placed in Claude's code-execution container, where Claude builds
the deck with Anthropic's pptx skill. Follow-up turns reuse the conversation and the container,
so Claude edits the deck it already made.

Claude cannot see images inside the container, so it cannot judge a slide's layout there. After it
saves a deck it renders each slide to a PNG; the backend sends those images back in a message, and
Claude checks spacing, alignment and overflow, fixes what is wrong and renders again, up to
REVIEW_ROUNDS times, before the deck is handed to the user. Only slides whose image differs from the
one Claude last checked are sent, so a follow-up that changes one slide costs one slide's check.
"""
from __future__ import annotations

import base64
import hashlib
import re
import threading
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from ..core.errors import ApiError
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, skills_script as K
from .runs import Run, RunStreamer
from .skills import SkillsService
from .spend import SpendTracker

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
SOURCE_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": PPTX,
    ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
}
MAX_FILES = 6
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PROMPT_CHARS = 4000
UPLOAD_EXPIRY_S = 24 * 3600  # your uploads delete themselves from the Files API after a day
MAX_CHATS = 20  # the oldest conversation is forgotten after this many
REVIEW_ROUNDS = 2  # how often Claude looks at the rendered slides and fixes what it sees
MAX_REVIEW_SLIDES = 30  # slide images in one review message; each costs roughly 700 input tokens
PPTX_SKILL = [{"type": "anthropic", "skill_id": "pptx", "version": "latest"}]
SLIDE_IMAGE = re.compile(r"slide-?(\d+)\.png$", re.IGNORECASE)

SYSTEM = """You make PowerPoint decks with the pptx skill in your code-execution container.
- Files the user attaches are uploaded into your container. Look for them before you start.
- When a template .pptx is attached, build the deck from it: keep its slide masters, layouts, theme colours and fonts, add your slides with its layouts, and remove its example slides unless the user asks to keep them.
- Base the content on the user's request and attached files. Do not invent figures; if something is missing, say so.
- Work in /tmp/deck, which stays between messages. To give the user a file, copy it into $OUTPUT_DIR in the same bash command, for example: cp /tmp/deck/quarterly-review.pptx "$OUTPUT_DIR"/. Every bash command gets its own new, empty $OUTPUT_DIR, and only files at its top level reach the user; a file saved anywhere else, such as /tmp/outputs, cannot be downloaded.
- Give the user the finished deck as a .pptx file with a short, descriptive file name. Do not give them PDFs or other working files unless they ask.
- On a follow-up request, change the latest deck and save it under a new version name, such as quarterly-review-v2.pptx, so every version stays downloadable.
- Every time you give the user a deck, also give them its slides as images so they can be checked by eye: convert the deck to PDF with LibreOffice, run the way the pptx skill says, then each page to a PNG 960 pixels wide (pdftoppm -png -scale-to 960 deck.pdf "$OUTPUT_DIR"/quarterly-review-v2-slide), which names them quarterly-review-v2-slide-01.png and so on. You cannot view images in the container; the backend sends the rendered slides back to you in a message.
- When the rendered slides come back, check each one for spacing, alignment, overflow and overlap, fix what is wrong, and reply as that message asks.
- Your final reply is short: one line per slide, then anything you could not do."""

REVIEW = """Here are the rendered slides of {deck} that are new or changed since you last checked them{note}. Check each one as a careful designer would:
- text that overflows its box, runs off the slide or is cut off
- shapes, images or text that overlap
- uneven spacing, cramped or unbalanced margins, inconsistent gaps between elements
- elements that should line up but do not: titles, bullets, columns, images
- text too small to read, or low contrast against its background
- empty placeholders, and example content left over from a template
{action}"""
FIX_AND_RENDER = """If every slide is right, do not change the deck, and reply with your final summary.
If anything is wrong, fix it in the deck, save it under a new version name, render its slides again, and reply with what you changed. You will be shown the new slides."""
FIX_LAST = """This is the last check. If every slide is right, do not change the deck, and reply with your final summary.
If anything is wrong, fix it, save the deck under a new version name, and reply with your final summary, then what you changed."""
RENDER = """Render every slide of {deck} to PNG as the system prompt describes, into $OUTPUT_DIR. Do not change the deck."""
DELIVER = """No file reached the user: only files copied to the top level of $OUTPUT_DIR in a bash command can be downloaded. Copy the latest deck into $OUTPUT_DIR now, and render its slides into $OUTPUT_DIR as the system prompt describes. Do not change the deck."""


@dataclass(frozen=True)
class Upload:
    name: str
    content: bytes


@dataclass
class DeckChat:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    turns: int = 0
    history: list[dict] = field(default_factory=list)
    container_id: str | None = None
    uploaded: list[str] = field(default_factory=list)  # Files API ids of the user's uploads
    checked: dict[int, str] = field(default_factory=dict)  # slide number -> hash of the image Claude last checked
    busy: threading.Lock = field(default_factory=threading.Lock)


class DeckChats:
    """The conversations in progress, oldest first."""

    def __init__(self, limit: int = MAX_CHATS):
        self.limit = limit
        self._chats: OrderedDict[str, DeckChat] = OrderedDict()
        self._lock = threading.Lock()

    def new(self) -> tuple[DeckChat, DeckChat | None]:
        """A new conversation, and the one forgotten to make room, if any."""
        chat = DeckChat()
        with self._lock:
            self._chats[chat.id] = chat
            dropped = self._chats.popitem(last=False)[1] if len(self._chats) > self.limit else None
        return chat, dropped

    def get(self, chat_id: str) -> DeckChat | None:
        with self._lock:
            return self._chats.get(chat_id)

    def remove(self, chat_id: str) -> DeckChat | None:
        with self._lock:
            return self._chats.pop(chat_id, None)


def check_upload(upload: Upload, *, template: bool = False) -> str:
    """The upload's media type, or a 400 explaining what is wrong with it."""
    suffix = Path(upload.name).suffix.lower()
    if template and suffix != ".pptx":
        raise ApiError(400, "invalid_request", f"The template must be a .pptx file, not {upload.name}.")
    if suffix not in SOURCE_TYPES:
        raise ApiError(400, "invalid_request",
                       f"{upload.name}: attach {', '.join(sorted(SOURCE_TYPES))} files only.")
    if len(upload.content) > MAX_FILE_BYTES:
        raise ApiError(400, "invalid_request", f"{upload.name} is larger than {MAX_FILE_BYTES // 2**20} MB.")
    if not upload.content:
        raise ApiError(400, "invalid_request", f"{upload.name} is empty.")
    return SOURCE_TYPES[suffix]


def user_message(prompt: str, sources: list[tuple[Upload, str]], template: tuple[Upload, str] | None) -> list[dict]:
    """The user's turn: the request, a note naming each attachment, then the attachments themselves."""
    notes = [f"- {u.name}" for u, _ in sources]
    if template:
        notes.append(f"- {template[0].name} (the template to build the deck from)")
    text = prompt + (f"\n\nAttached files:\n" + "\n".join(notes) if notes else "")
    files = [*sources, *([template] if template else [])]
    return [{"type": "text", "text": text}, *({"type": "container_upload", "file_id": fid} for _, fid in files)]


def reply_text(result: K.SkillsResult) -> str:
    return " ".join(b.text for b in result.messages[-1]["content"] if getattr(b, "type", None) == "text")


def is_slide_image(file: dict) -> bool:
    return bool(SLIDE_IMAGE.search(file["name"]))


def slide_number(file: dict) -> int:
    return int(SLIDE_IMAGE.search(file["name"]).group(1))


def review_message(deck: str, slides: list[tuple[int, bytes]], unchanged: list[int], left_out: int,
                   last: bool) -> list[dict]:
    """The changed slides, each labelled with its number, and what to check on them."""
    notes = []
    if unchanged:
        which = f"slide {unchanged[0]} looks" if len(unchanged) == 1 else f"slides {', '.join(map(str, unchanged))} look"
        notes.append(f"{which} exactly as when you checked them, so they are not shown")
    if left_out:
        notes.append(f"{left_out} more changed slides are left out to keep this message small")
    note = f" ({'; '.join(notes)})" if notes else ""
    content: list[dict] = [{"type": "text", "text": REVIEW.format(deck=deck, note=note,
                                                                  action=FIX_LAST if last else FIX_AND_RENDER)}]
    for number, png in slides:
        content += [{"type": "text", "text": f"Slide {number}"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                 "data": base64.b64encode(png).decode()}}]
    return content


class DeckService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer, skills: SkillsService,
                 chats: DeckChats):
        self.claude, self.spend, self.streamer, self.skills, self.chats = claude, spend, streamer, skills, chats

    def turn(self, chat_id: str | None, prompt: str, model: str | None, sources: list[Upload],
             template: Upload | None) -> Iterator[str]:
        """Checks the request, then starts one turn of the conversation and returns its stream of events."""
        prompt = prompt.strip()
        if not prompt or len(prompt) > MAX_PROMPT_CHARS:
            raise ApiError(400, "invalid_request", f"Write a request of 1 to {MAX_PROMPT_CHARS:,} characters.")
        if len(sources) + bool(template) > MAX_FILES:
            raise ApiError(400, "invalid_request", f"Attach at most {MAX_FILES} files in one message.")
        checked = [(u, check_upload(u)) for u in sources]
        checked_template = (template, check_upload(template, template=True)) if template else None
        if chat_id:
            chat = self.chats.get(chat_id)
            if chat is None:
                raise ApiError(404, "not_found", "This conversation has expired. Start a new deck.")
        else:
            chat, dropped = self.chats.new()
            if dropped:
                self._forget(dropped)
        if not chat.busy.acquire(blocking=False):
            raise ApiError(409, "busy", "Claude is still working on this deck. Wait for it, or press Stop.")
        model = model or DEFAULT_MODEL
        run = Run()

        def work() -> None:
            try:
                run.publish({"type": "chat", "chat_id": chat.id, "turn": chat.turns + 1, "model": model})
                uploaded = [(u, self._upload(chat, u, media, run)) for u, media in checked]
                template_id = (checked_template[0], self._upload(chat, *checked_template, run)) if checked_template else None
                self._build(chat, model, run, user_message(prompt, uploaded, template_id))
            finally:
                chat.busy.release()

        return self.streamer.lines(run, work)

    def _build(self, chat: DeckChat, model: str, run: Run, message: list[dict]) -> None:
        """One turn: Claude builds or changes the deck, then checks its rendered slides and fixes them."""
        described: dict[str, dict] = {}

        def describe(file_ids: list[str]) -> list[dict]:
            new = [i for i in dict.fromkeys(file_ids) if i not in described]
            described.update((f["id"], f) for f in self.skills.register(new))
            return [described[i] for i in dict.fromkeys(file_ids)]

        def ask(content: list[dict], after: K.SkillsResult | None) -> K.SkillsResult:
            history, container_id = (after.messages, after.container_id) if after else (chat.history, chat.container_id)
            return K.run_with_skills(self.claude.client, model, PPTX_SKILL, content, emit=run.publish,
                                     on_response=lambda resp: self.spend.charge(resp, model),
                                     cancelled=run.cancelled.is_set, history=history, container_id=container_id,
                                     system=SYSTEM)

        def finished(result: K.SkillsResult) -> bool:
            return not run.cancelled.is_set() and result.messages[-1]["role"] == "assistant"

        checked = dict(chat.checked)  # saved to the chat only if the turn is kept
        results = [ask(message, None)]
        asked_to_deliver = False
        for round_ in range(1, REVIEW_ROUNDS + 1):
            latest = results[-1]
            decks = [f for f in describe(latest.file_ids) if f["name"].lower().endswith(".pptx")]
            if not decks and not asked_to_deliver and finished(latest) and ".pptx" in reply_text(latest).lower():
                asked_to_deliver = True  # Claude says it made a deck, but saved it where the user cannot get it
                results.append(latest := ask([{"type": "text", "text": DELIVER}], latest))
                decks = [f for f in describe(latest.file_ids) if f["name"].lower().endswith(".pptx")]
            if not finished(latest) or not decks:
                break  # stopped, or no new deck to check: Claude approved the last one or asked a question
            deck = decks[-1]["name"]
            slides = [f for f in describe(latest.file_ids) if is_slide_image(f)]
            if not slides:  # Claude forgot to render them: ask once
                results.append(latest := ask([{"type": "text", "text": RENDER.format(deck=deck)}], latest))
                if not finished(latest):
                    break
                slides = [f for f in describe(latest.file_ids) if is_slide_image(f)]
            slides.sort(key=slide_number)
            rendered = {slide_number(f): (f, png) for f in slides
                        if (png := self.claude.file_bytes(f["id"])).startswith(b"\x89PNG")}
            if not rendered:
                run.publish({"type": "review", "round": round_, "deck": deck, "slides": [],
                             "text": "Claude could not render the slides, so they were not checked by eye."})
                break
            hashes = {n: hashlib.sha256(png).hexdigest() for n, (_, png) in rendered.items()}
            changed = [n for n in rendered if checked.get(n) != hashes[n]]
            unchanged = [n for n in rendered if n not in changed]
            shown = changed[:MAX_REVIEW_SLIDES]
            # Slides removed from the deck are forgotten; changed slides left out are checked next time.
            checked = {n: h for n, h in hashes.items() if n not in changed[MAX_REVIEW_SLIDES:]}
            if not changed:
                run.publish({"type": "review", "round": round_, "deck": deck, "slides": [], "total": len(rendered),
                             "text": "No slide looks different from when Claude last checked it, so there was nothing to check."})
                break
            run.publish({"type": "review", "round": round_, "deck": deck, "total": len(rendered),
                         "slides": [rendered[n][0] for n in shown]})
            results.append(ask(review_message(deck, [(n, rendered[n][1]) for n in shown], unchanged,
                                              len(changed) - len(shown), last=round_ == REVIEW_ROUNDS), latest))

        final = results[-1]
        if finished(final):  # a stopped turn is not kept
            chat.history, chat.container_id, chat.checked = final.messages, final.container_id, checked
            chat.turns += 1
        made = [f for f in describe([i for r in results for i in r.file_ids]) if not is_slide_image(f)]
        decks = [f for f in made if f["name"].lower().endswith(".pptx")]
        # Versions saved while Claude fixed what it saw are drafts: offer only this turn's final deck.
        offered = [f for f in made if f not in decks[:-1]]
        run.publish({"type": "files", "files": offered,
                     "cost": round(sum(r.cost for r in results), 4), "spent_usd": round(self.spend.spent_usd, 4)})

    def end(self, chat_id: str) -> None:
        chat = self.chats.remove(chat_id)
        if chat is None:
            raise ApiError(404, "not_found", "There is no conversation with that id.")
        self._forget(chat)

    def _upload(self, chat: DeckChat, upload: Upload, media_type: str, run: Run) -> str:
        file_id = self.claude.upload(upload.name, upload.content, media_type, UPLOAD_EXPIRY_S)
        chat.uploaded.append(file_id)
        run.publish({"type": "upload", "name": upload.name, "size_bytes": len(upload.content), "file_id": file_id})
        return file_id

    def _forget(self, chat: DeckChat) -> None:
        """Deletes the user's uploads now rather than waiting for them to expire. Best effort."""
        for file_id in chat.uploaded:
            try:
                self.claude.delete_file(file_id)
            except Exception:
                pass
