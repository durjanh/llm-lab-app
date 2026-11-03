"""Document automation: templates, an interview, and assembly.

Assembly is deterministic: a Word template with docxtpl fields ({{ variable }}, {%p if %} clauses
and {%p for %} repeats, the counterparts of a document automation tool's variables, IF and REPEAT) is filled from the
answers, and the same answers always give the same document. Claude works around it, never inside
it, and every result is structured data a person confirms:

- Authoring: Claude turns a finished document into a template, proposing fields, their questions
  and which clauses should be optional.
- Interview: Claude reads source documents, such as an intake email, and proposes answers, each
  with the quote it came from and a confidence.
- Review: Claude checks the assembled document for inconsistencies.
"""
from __future__ import annotations

import base64
import datetime as dt
import io
import json
import re
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from docx import Document
from docx.oxml import OxmlElement
from docx.text.paragraph import Paragraph
from docxtpl import DocxTemplate
from jinja2 import TemplateError

from ..core.errors import ApiError, to_api_error
from ..gateways.azure_openai import StructuredModel
from ..gateways.claude import ClaudeGateway
from ..settings import MODELS
from ..shared import DEFAULT_MODEL, cost_usd, text_of
from .document_samples import INTAKE_EMAIL, SAMPLES
from .spend import SpendTracker

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FIELD_TYPES = ["text", "longtext", "date", "number", "money", "boolean", "choice", "list"]
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_SOURCE_CHARS = 60_000
MAX_KEPT = 30  # templates and assembled documents kept in memory, oldest dropped first
NAME = re.compile(r"^[a-z][a-z0-9_]{0,39}$")

FIELD = {
    "type": "object", "additionalProperties": False,
    "required": ["name", "question", "type", "help", "options", "required", "group"],
    "properties": {
        "name": {"type": "string", "description": "snake_case, as used in the template"},
        "question": {"type": "string", "description": "the interview question, in plain words"},
        "type": {"type": "string", "enum": FIELD_TYPES},
        "help": {"type": "string", "description": "a short hint, or an empty string"},
        "options": {"type": "array", "items": {"type": "string"}, "description": "for choice fields only"},
        "required": {"type": "boolean"},
        "group": {"type": "string", "description": "a short section name, such as Parties or Fees"},
    },
}
SCHEMA_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["title", "fields"],
                 "properties": {"title": {"type": "string"}, "fields": {"type": "array", "items": FIELD}}}
AUTHOR_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["title", "replacements", "optional_clauses", "fields"],
    "properties": {
        "title": {"type": "string"},
        "replacements": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["text", "field", "within"],
            "properties": {"text": {"type": "string", "description": "exact text from the document, copied character for character"},
                           "field": {"type": "string"},
                           "within": {"type": "string", "description": "a longer exact phrase around the text, to replace it only there; or empty"}}}},
        "optional_clauses": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["starts_with", "field"],
            "properties": {"starts_with": {"type": "string", "description": "the first eight or so words of the paragraph, exactly"},
                           "field": {"type": "string", "description": "a boolean field that includes the clause when true"}}}},
        "fields": {"type": "array", "items": FIELD},
    },
}
EXTRACT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["answers"],
    "properties": {"answers": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["field", "value", "quote", "confidence"],
        "properties": {
            "field": {"type": "string"},
            "value": {"type": "string", "description": "for boolean fields true or false; for list fields one item per line; for dates YYYY-MM-DD"},
            "quote": {"type": "string", "description": "the exact words in the source that support the value"},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        }}}},
}
CHAT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["answers", "reply"],
    "properties": {"answers": EXTRACT_SCHEMA["properties"]["answers"], "reply": {"type": "string"}},
}
REVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["issues", "summary"],
    "properties": {
        "summary": {"type": "string"},
        "issues": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["severity", "issue", "quote", "suggestion"],
            "properties": {"severity": {"type": "string", "enum": ["high", "medium", "low"]},
                           "issue": {"type": "string"}, "quote": {"type": "string"}, "suggestion": {"type": "string"}}}},
    },
}

SCHEMA_SYSTEM = """You design the interview for a document automation template. You are given the template's text, with its fields written as {{ name }}, its optional or alternative clauses as {%p if name %} ... {%p else %} ... {%p endif %}, and repeated items as {%p for item in name %}.
Describe every field listed, in the order a lawyer would want to answer them, grouped into short sections. Use the field's context in the text to choose its type: boolean for anything used in an if, list for anything repeated in a for, date, money or number where the text shows it, choice with options when there is a small fixed set, longtext for descriptions, otherwise text. Questions are short and plain. Mark a field required unless the template only uses it in one branch of an if."""

AUTHOR_SYSTEM = """You turn a finished legal or business document into a reusable template for document automation.
- Find every detail that would change in the next document of this kind: party names, company numbers, addresses, dates, amounts, durations, the purpose, governing law, signatories. For each, give the exact text as it appears in the document (copy it character for character, without the surrounding words) and a snake_case field name. Give each distinct piece of text once; the same field may be used for several texts, for example a full name and a short name for the same party.
- A replacement changes every place its text appears, unless you give "within": a longer exact phrase around it, so it is replaced only inside that phrase. When the same words mean different things in different places, use within. For example, "England and Wales" with within "registered in England and Wales" for a registration_jurisdiction field, and "England and Wales" with within "the law of England and Wales" for governing_law. Otherwise leave within empty.
- Always make optional any clause a lawyer commonly includes or leaves out, such as non-solicitation, non-compete, exclusivity, liquidated damages or an option to extend: give the exact first eight or so words of its paragraph and a boolean field such as include_non_solicitation. A clause can be optional and still have fields inside it, such as its duration.
- Then describe every field for the interview: the question, its type (text, longtext, date, number, money, boolean, choice, list), a short hint, options for choices, whether it is required, and a short section name. Dates in the document become date fields.
- Never invent text that is not in the document. Change nothing else."""

EXTRACT_SYSTEM = """You fill in a document automation interview from source documents, such as an email, a term sheet or notes.
For each field, give a value only when the sources support it, with the exact words from the sources that support it as the quote, and your confidence: high when the sources state it plainly, medium when it is inferred from clear context, low when it is a guess. Leave out fields the sources say nothing about; never invent names, numbers or dates.
Each value is inserted into the template exactly where its field appears, and you are shown the words around it. Write the value so the finished sentence reads correctly: for "in relation to {{ matter_description }}." write "the review of its supplier contracts", not a capitalised sentence with its own full stop; for "under the law of {{ governing_law }}" write "England and Wales", not "English law". Name the client rather than writing "the client".
Formats: dates as YYYY-MM-DD; booleans as true or false; list fields as one item per line; money with its currency symbol, as written; a choice must be one of its options."""

CHAT_SYSTEM = """You help someone fill in a document's interview by talking, typed or spoken (spoken words are transcribed, so a word may be wrong; make your best guess). A message may also paste notes or attach documents, such as an email or a term sheet.
From their latest message and anything attached to it, give a value for every field it states or changes, with the exact words it came from as the quote and your confidence: high when stated plainly, medium when inferred from clear context, low when a guess. A correction such as "actually the fee is five thousand" replaces the earlier value. Never fill a field the message does not mention, and never invent values.
Formats: dates as YYYY-MM-DD (today's date is given, so "next Monday" can be worked out); booleans as true or false; list fields as one item per line; money with its currency symbol; a choice must be one of its options. Each value is inserted where its field appears in the template, shown in the field list, so write it to fit that sentence.
Then write a short reply, as one would say it aloud: confirm what you filled in plain words (not field names), then ask for the next most important required field that is still empty, one question at a time. When every required field is answered, say so and suggest assembling the document. If they ask a question about the document, answer it briefly."""

REVIEW_SYSTEM = """You check an assembled legal or business document before it is sent. Report only real problems a careful lawyer would want to fix: inconsistent names, dates that contradict each other or are in the past, amounts or totals that do not agree, empty or placeholder text, wrong pronouns or party references, a clause that contradicts another, or anything that looks like a missing answer. Quote the exact words, say what is wrong and how to fix it. Do not rewrite style. If there is nothing to fix, return no issues and say so in the summary."""


@dataclass
class Template:
    id: str
    name: str
    content: bytes  # the .docx with docxtpl fields
    title: str
    fields: list[dict]
    made_by_ai: bool
    cost: float = 0.0


@dataclass
class Assembled:
    id: str
    name: str
    content: bytes
    text: str


@dataclass
class Kept:
    """The newest MAX_KEPT items, oldest dropped first."""
    items: OrderedDict = field(default_factory=OrderedDict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, item: Any) -> None:
        with self.lock:
            self.items[item.id] = item
            while len(self.items) > MAX_KEPT:
                self.items.popitem(last=False)

    def get(self, item_id: str) -> Any:
        with self.lock:
            return self.items.get(item_id)


def document_text(content: bytes) -> str:
    """The text of a .docx, paragraph by paragraph, tables included."""
    doc = Document(io.BytesIO(content))
    lines = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            lines.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(line for line in lines if line.strip())


def all_paragraphs(doc: Any) -> list[Paragraph]:
    """Every paragraph: the body, tables (nested too), headers and footers."""
    found: list[Paragraph] = []

    def walk(container: Any) -> None:
        found.extend(container.paragraphs)
        for table in getattr(container, "tables", []):
            for row in table.rows:
                for cell in row.cells:
                    walk(cell)

    walk(doc)
    for section in doc.sections:
        for part in (section.header, section.footer):
            walk(part)
    return found


def replace_in_paragraph(paragraph: Paragraph, old: str, new: str) -> int:
    """Replaces text that may be split across several runs, keeping the formatting of the run it starts in."""
    count = 0
    while count < 50:
        runs = paragraph.runs
        full = "".join(r.text for r in runs)
        start = full.find(old)
        if start < 0:
            return count
        end, pos, first = start + len(old), 0, True
        for run in runs:
            run_start, run_end = pos, pos + len(run.text)
            pos = run_end
            if run_end <= start or run_start >= end:
                continue
            a, b = max(start, run_start) - run_start, min(end, run_end) - run_start
            run.text = run.text[:a] + (new if first else "") + run.text[b:]
            first = False
        count += 1
    return count


def is_heading(paragraph: Paragraph) -> bool:
    return paragraph.style is not None and paragraph.style.name.lower().startswith(("heading", "title"))


def clause_span(paragraph: Paragraph, siblings: list[Paragraph]) -> tuple[Paragraph, Paragraph]:
    """The first and last paragraph of a clause. Given a heading, the clause is the heading and the
    paragraphs under it, up to the next heading; given a paragraph straight after a heading, the
    heading comes too, so a left-out clause takes its heading with it."""
    i = next(n for n, p in enumerate(siblings) if p._p is paragraph._p)
    if is_heading(paragraph):
        last = i
        while last + 1 < len(siblings) and not is_heading(siblings[last + 1]):
            last += 1
        return paragraph, siblings[last]
    first = i - 1 if i > 0 and is_heading(siblings[i - 1]) else i
    return siblings[first], paragraph


def index_of(paragraph: Paragraph, siblings: list[Paragraph]) -> int:
    return next(n for n, p in enumerate(siblings) if p._p is paragraph._p)


def wrap_clause(first: Paragraph, last: Paragraph, before: str, after: str) -> None:
    """Puts docxtpl paragraph tags, such as {%p if x %} and {%p endif %}, around a run of paragraphs."""
    first.insert_paragraph_before(before)
    element = OxmlElement("w:p")
    last._p.addnext(element)
    Paragraph(element, last._parent).add_run(after)


def template_fields(content: bytes) -> tuple[list[str], set[str], set[str]]:
    """The template's variables, and which of them are used in an if (booleans) or a for (lists)."""
    try:
        variables = sorted(DocxTemplate(io.BytesIO(content)).get_undeclared_template_variables())
    except TemplateError as exc:
        raise ApiError(400, "invalid_request", f"The template has a mistake in its fields: {exc}") from exc
    text = document_text(content)
    booleans = set(re.findall(r"{%-?p?\s*(?:if|elif)\s+(?:not\s+)?([a-z_][a-z0-9_]*)", text, re.I))
    lists = set(re.findall(r"{%-?p?\s*for\s+\w+\s+in\s+([a-z_][a-z0-9_]*)", text, re.I))
    return variables, booleans, lists


def format_value(value: Any, kind: str) -> Any:
    """An answer as the template uses it: dates written out, booleans and lists as Python values."""
    if kind == "boolean":
        return value is True or str(value).strip().lower() in ("true", "yes", "1")
    if kind == "list":
        items = value if isinstance(value, list) else str(value or "").splitlines()
        return [str(i).strip(" -•\t") for i in items if str(i).strip(" -•\t")]
    if kind == "date" and isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        day = dt.date.fromisoformat(value)
        return f"{day.day} {day.strftime('%B %Y')}"
    return "" if value is None else str(value)


class DocumentService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, gpt: StructuredModel | None = None):
        self.claude, self.spend = claude, spend
        self.gpt = gpt  # GPT deployments in Azure AI Foundry, if configured: an alternative to Claude for every AI step
        self.templates, self.assembled = Kept(), Kept()

    # Templates ---------------------------------------------------------------------------------

    def sample(self, name: str) -> tuple[str, bytes]:
        if name == "intake-email.txt":
            return "text/plain; charset=utf-8", INTAKE_EMAIL.encode()
        if name not in SAMPLES:
            raise ApiError(404, "not_found", "There is no sample with that name.")
        return DOCX, SAMPLES[name]()

    def add_template(self, name: str, content: bytes, model: str | None) -> dict:
        """A Word file that already has fields: Claude writes the interview for them."""
        check_docx(name, content)
        variables, booleans, lists = template_fields(content)
        if not variables:
            raise ApiError(400, "invalid_request", "This document has no {{ fields }}. To make a template from a finished "
                                                   "document, use Make a template with AI.")
        model = model or DEFAULT_MODEL
        listing = "\n".join(f"- {v}" + (" (used in an if)" if v in booleans else " (repeated in a for)" if v in lists else "")
                            for v in variables)
        result, cost = self._ask(model, SCHEMA_SYSTEM, SCHEMA_SCHEMA,
                                 f"Fields:\n{listing}\n\nTemplate text:\n{document_text(content)[:MAX_SOURCE_CHARS]}")
        fields = clean_fields(result["fields"], variables, booleans, lists)
        template = Template(uuid.uuid4().hex[:12], name, content, result["title"] or Path(name).stem, fields, False, cost)
        self.templates.add(template)
        return describe(template)

    def author(self, name: str, content: bytes, model: str | None) -> dict:
        """A finished document: Claude proposes the fields and optional clauses, and the template is built from them."""
        check_docx(name, content)
        model = model or DEFAULT_MODEL
        result, cost = self._ask(model, AUTHOR_SYSTEM, AUTHOR_SCHEMA,
                                 f"Document:\n{document_text(content)[:MAX_SOURCE_CHARS]}", max_tokens=12000)
        doc = Document(io.BytesIO(content))
        paragraphs = all_paragraphs(doc)
        # Find the optional clauses first, by the words Claude saw, before any of them become fields.
        body = list(doc.paragraphs)
        spans = []
        for clause in result["optional_clauses"]:
            start, name_ = " ".join(clause["starts_with"].split()), clause["field"]
            if not NAME.match(name_) or len(start) < 8:
                continue
            target = next((p for p in body if " ".join(p.text.split()).startswith(start)), None)
            if target is None:
                continue
            first, last = clause_span(target, body)
            covered = range(index_of(first, body), index_of(last, body) + 1)
            # Claude may name a clause by its heading and again by its text: wrap it once.
            if any(set(covered) & set(range(index_of(f, body), index_of(l, body) + 1)) for (f, l), _, _ in spans):
                continue
            spans.append(((first, last), name_, start))
        made, missing = [], []
        # Replacements limited to a phrase go first, then the longest text first, so "Northwind Traders
        # Limited" is replaced before "Northwind".
        for item in sorted(result["replacements"], key=lambda r: (not r.get("within"), -len(r["text"]))):
            text, name_, within = item["text"], item["field"], (item.get("within") or "").strip()
            if not text.strip() or not NAME.match(name_):
                continue
            placeholder = "{{ " + name_ + " }}"
            if within and text in within:
                count = sum(replace_in_paragraph(p, within, within.replace(text, placeholder, 1)) for p in paragraphs)
            else:
                count = sum(replace_in_paragraph(p, text, placeholder) for p in paragraphs)
            (made if count else missing).append({"text": text, "field": name_, "count": count})
        clauses = []
        for (first, last), name_, start in spans:
            wrap_clause(first, last, "{%p if " + name_ + " %}", "{%p endif %}")
            clauses.append({"field": name_, "starts_with": start})
        buffer = io.BytesIO()
        doc.save(buffer)
        templated = buffer.getvalue()
        variables, booleans, lists = template_fields(templated)
        fields = clean_fields(result["fields"], variables, booleans, lists)
        template = Template(uuid.uuid4().hex[:12], f"{Path(name).stem}-template.docx", templated,
                            result["title"] or Path(name).stem, fields, True, cost)
        self.templates.add(template)
        return {**describe(template), "replaced": made, "not_found": missing, "optional_clauses": clauses}

    def template(self, template_id: str) -> Template:
        template = self.templates.get(template_id)
        if template is None:
            raise ApiError(404, "not_found", "This template has expired. Load it again.")
        return template

    # Interview -------------------------------------------------------------------------------

    def extract(self, template_id: str, sources: list[tuple[str, bytes]], note: str, model: str | None) -> dict:
        """Proposed answers from source documents, each with its quote and confidence, for a person to confirm."""
        template = self.template(template_id)
        model = model or DEFAULT_MODEL
        content: list[dict] = []
        for name, data in sources:
            content += source_blocks(name, data)
        if note.strip():
            content.append({"type": "text", "text": f"Notes from the user:\n{note.strip()[:MAX_SOURCE_CHARS]}"})
        if not content:
            raise ApiError(400, "invalid_request", "Add a source document or paste some notes.")
        text = document_text(template.content)
        fields = "\n".join(f"- {f['name']} ({f['type']}{': ' + ', '.join(f['options']) if f['options'] else ''}): "
                           f"{f['question']}{context_of(text, f['name'])}" for f in template.fields)
        content.append({"type": "text", "text": f"Today's date is {dt.date.today().isoformat()}.\nThe interview's fields:\n{fields}"})
        result, cost = self._ask(model, EXTRACT_SYSTEM, EXTRACT_SCHEMA, content)
        known = {f["name"]: f for f in template.fields}
        answers = [a for a in result["answers"] if a["field"] in known and a["value"].strip()]
        return {"answers": answers, "cost": round(cost, 5), "spent_usd": round(self.spend.spent_usd, 4)}

    def chat(self, template_id: str, message: str, answers: dict[str, Any], history: list[dict], model: str | None,
             sources: list[tuple[str, bytes]] | None = None) -> dict:
        """One message of filling the interview: typed, spoken, pasted or with documents attached. Returns the
        values it gives, each with the words it came from, and a reply that asks for what is still missing."""
        template = self.template(template_id)
        model = model or DEFAULT_MODEL
        text = document_text(template.content)
        lines = []
        for f in template.fields:
            value = answers.get(f["name"])
            shown = "(empty)" if value in (None, "", []) else json.dumps(value, ensure_ascii=False)
            lines.append(f"- {f['name']} ({f['type']}{', required' if f['required'] and f['type'] != 'boolean' else ''}"
                         f"{': ' + ', '.join(f['options']) if f['options'] else ''}): {f['question']} = {shown}"
                         f"{context_of(text, f['name'])}")
        earlier = "\n".join(f"{m['role']}: {m['text']}" for m in history[-10:])
        text_part = (f"Today's date is {dt.date.today().isoformat()}.\nThe interview's fields and their current values:\n"
                     + "\n".join(lines) + (f"\n\nThe conversation so far:\n{earlier}" if earlier else "")
                     + f"\n\nTheir latest message:\n{message.strip() or '(no text: fill in what you can from the attached documents)'}")
        content: list[dict] = []
        for name, data in sources or []:
            content += source_blocks(name, data)
        content.append({"type": "text", "text": text_part})
        result, cost = self._ask(model, CHAT_SYSTEM, CHAT_SCHEMA, content, max_tokens=4000)
        known = {f["name"] for f in template.fields}
        return {"answers": [a for a in result["answers"] if a["field"] in known and a["value"].strip()],
                "reply": result["reply"], "cost": round(cost, 5), "spent_usd": round(self.spend.spent_usd, 4)}

    # Assembly --------------------------------------------------------------------------------

    def assemble(self, template_id: str, answers: dict[str, Any]) -> dict:
        """Fills the template from the answers. No AI: the same answers always give the same document."""
        template = self.template(template_id)
        context = {f["name"]: format_value(answers.get(f["name"]), f["type"]) for f in template.fields}
        missing = [f["question"] for f in template.fields if f["required"] and context[f["name"]] in ("", [], None)
                   and f["type"] != "boolean"]
        tpl = DocxTemplate(io.BytesIO(template.content))
        try:
            tpl.render(context, autoescape=True)
        except TemplateError as exc:
            raise ApiError(400, "invalid_request", f"The template could not be filled in: {exc}") from exc
        buffer = io.BytesIO()
        tpl.save(buffer)
        content = buffer.getvalue()
        slug = re.sub(r"[^\w-]+", "-", template.title.lower()).strip("-")[:40] or "document"
        made = Assembled(uuid.uuid4().hex[:12], f"{slug}.docx", content, document_text(content))
        self.assembled.add(made)
        return {"id": made.id, "name": made.name, "text": made.text, "missing": missing}

    def preview(self, template_id: str, answers: dict[str, Any]) -> dict:
        """The document as the answers stand, to show beside the interview. Each answered value is
        wrapped in ⟦ ⟧ and each empty field shows as ⟦?its question⟧, so the page can highlight both.
        No AI and nothing kept: the same assembly as the real document."""
        template = self.template(template_id)
        context = {}
        for f in template.fields:
            value = format_value(answers.get(f["name"]), f["type"])
            if f["type"] == "boolean":
                context[f["name"]] = value
            elif f["type"] == "list":
                context[f["name"]] = [f"⟦{v}⟧" for v in value] or [f"⟦?{f['question']}⟧"]
            else:
                context[f["name"]] = f"⟦{value}⟧" if value else f"⟦?{f['question']}⟧"
        tpl = DocxTemplate(io.BytesIO(template.content))
        try:
            tpl.render(context, autoescape=True)
        except TemplateError as exc:
            raise ApiError(400, "invalid_request", f"The template could not be filled in: {exc}") from exc
        buffer = io.BytesIO()
        tpl.save(buffer)
        return {"text": document_text(buffer.getvalue())}

    def document(self, document_id: str) -> Assembled:
        made = self.assembled.get(document_id)
        if made is None:
            raise ApiError(404, "not_found", "This document has expired. Assemble it again.")
        return made

    def review(self, document_id: str, model: str | None) -> dict:
        made = self.document(document_id)
        model = model or DEFAULT_MODEL
        result, cost = self._ask(model, REVIEW_SYSTEM, REVIEW_SCHEMA,
                                 f"Today's date is {dt.date.today().isoformat()}.\nDocument:\n{made.text[:MAX_SOURCE_CHARS]}")
        return {**result, "cost": round(cost, 5), "spent_usd": round(self.spend.spent_usd, 4)}

    # Claude ----------------------------------------------------------------------------------

    def _ask(self, model: str, system: str, schema: dict, content: Any, max_tokens: int = 8000) -> tuple[dict, float]:
        """One call whose answer must match the schema (structured outputs), and what it cost.
        A GPT deployment answers the same schema and prompts, so the two can be compared like for like."""
        if self.gpt and model in self.gpt.models:
            answer, usage = self.gpt.structured(model, system, schema, content, max_tokens)
            return answer, self.spend.charge(SimpleNamespace(usage=usage), model) or 0.0
        if model not in MODELS:
            choices = MODELS + (self.gpt.models if self.gpt else [])
            raise ApiError(400, "invalid_request", f"model: Model must be one of: {', '.join(choices)}")
        try:
            response = self.claude.create(
                model=model, max_tokens=max_tokens, system=system, messages=[{"role": "user", "content": content}],
                output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}})
        except Exception as exc:
            raise to_api_error(exc) from exc
        self.spend.charge(response, model)
        if response.stop_reason == "max_tokens":
            raise ApiError(502, "too_long", "Claude's answer was cut off. Try a shorter document.")
        return json.loads(text_of(response)), cost_usd(response.usage, model) or 0.0


def check_docx(name: str, content: bytes) -> None:
    if not name.lower().endswith(".docx"):
        raise ApiError(400, "invalid_request", "Upload a Word document (.docx).")
    if len(content) > MAX_FILE_BYTES:
        raise ApiError(400, "invalid_request", f"The file is larger than {MAX_FILE_BYTES // 2**20} MB.")
    try:
        Document(io.BytesIO(content))
    except Exception as exc:
        raise ApiError(400, "invalid_request", f"{name} could not be read as a Word document.") from exc


def clean_fields(proposed: list[dict], variables: list[str], booleans: set[str], lists: set[str]) -> list[dict]:
    """Claude's field descriptions, checked against the template: every variable once, the right kind for ifs and fors."""
    by_name = {f["name"]: f for f in proposed if f["name"] in variables}
    fields = []
    for name in [f["name"] for f in proposed if f["name"] in variables] + [v for v in variables if v not in by_name]:
        if any(f["name"] == name for f in fields):
            continue
        f = dict(by_name.get(name) or {"name": name, "question": name.replace("_", " ").capitalize(), "type": "text",
                                        "help": "", "options": [], "required": True, "group": "Other"})
        if name in booleans:
            f["type"], f["required"] = "boolean", False
        elif name in lists:
            f["type"] = "list"
        if f["type"] not in FIELD_TYPES:
            f["type"] = "text"
        fields.append(f)
    return fields


def context_of(text: str, name: str, width: int = 70) -> str:
    """The words around a field's first use in the template, so its value can be written to fit."""
    match = re.search(r"{{\s*" + re.escape(name) + r"\s*}}|{%-?p?\s*(?:if|for\s+\w+\s+in)\s+" + re.escape(name) + r"\b", text)
    if not match:
        return ""
    snippet = text[max(0, match.start() - width):match.end() + width].replace("\n", " ")
    return f' (used in: "...{snippet}...")'


def describe(template: Template) -> dict:
    return {"id": template.id, "name": template.name, "title": template.title, "fields": template.fields,
            "made_by_ai": template.made_by_ai, "text": document_text(template.content), "cost": round(template.cost, 5)}


def source_blocks(name: str, data: bytes) -> list[dict]:
    """A source document as content Claude can read: PDFs as documents, Word as text, text as text."""
    lower = name.lower()
    if len(data) > MAX_FILE_BYTES:
        raise ApiError(400, "invalid_request", f"{name} is larger than {MAX_FILE_BYTES // 2**20} MB.")
    if lower.endswith(".pdf"):
        return [{"type": "document", "title": name,
                 "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(data).decode()}}]
    if lower.endswith(".docx"):
        text = document_text(data)
    elif lower.endswith((".txt", ".md", ".eml", ".csv", ".json")):
        text = data.decode("utf-8", errors="replace")
    else:
        raise ApiError(400, "invalid_request", f"{name}: use PDF, Word, text or email files.")
    return [{"type": "text", "text": f"Source document {name}:\n{text[:MAX_SOURCE_CHARS]}"}]
