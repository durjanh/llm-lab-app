"""Document automation, against a fake Claude client: no network, no cost."""
from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

import pytest
from anthropic.types import Message
from docx import Document
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services.document_samples import engagement_letter_template, finished_nda
from backend.app.services.documents import AUTHOR_SYSTEM, CHAT_SYSTEM, EXTRACT_SYSTEM, REVIEW_SYSTEM, SCHEMA_SYSTEM
from backend.app.settings import Settings
from backend.tests.test_api import LAB

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def field(name: str, kind: str = "text", question: str = "", required: bool = True) -> dict:
    return {"name": name, "question": question or name, "type": kind, "help": "", "options": [], "required": required,
            "group": "Details"}


SCHEMA_REPLY = {"title": "Letter of engagement", "fields": [
    field("client_name", question="Client's name"), field("fixed_fee", "text"), field("deliverables", "text"),
    field("start_date", "date"),
    field("not_in_template")]}
AUTHOR_REPLY = {
    "title": "Mutual NDA",
    "replacements": [{"text": "Northwind Traders Limited", "field": "party_a_name", "within": ""},
                     {"text": "Northwind", "field": "party_a_short_name", "within": ""},
                     {"text": "2 September 2026", "field": "agreement_date", "within": ""},
                     {"text": "England and Wales", "field": "governing_law", "within": "the law of England and Wales"},
                     {"text": "England and Wales", "field": "registration_jurisdiction", "within": "registered in England and Wales"},
                     {"text": "text that is not there", "field": "ghost", "within": ""}],
    "optional_clauses": [{"starts_with": "For 12 months after this Agreement ends, neither party",
                          "field": "include_non_solicitation"}],
    "fields": [field("party_a_name", question="First party's full name"), field("agreement_date", "date")],
}
EXTRACT_REPLY = {"answers": [
    {"field": "client_name", "value": "Brightwater Logistics Ltd", "quote": "Brightwater Logistics Ltd, 14 Harbour Road", "confidence": "high"},
    {"field": "start_date", "value": "2026-11-03", "quote": "start on 3 November 2026", "confidence": "high"},
    {"field": "made_up", "value": "x", "quote": "", "confidence": "low"}]}
REVIEW_REPLY = {"summary": "One date needs checking.", "issues": [
    {"severity": "medium", "issue": "The start date is before the letter date.", "quote": "3 November 2025", "suggestion": "Use 2026."}]}
CHAT_REPLY = {"answers": [
    {"field": "client_name", "value": "Brightwater Logistics Ltd", "quote": "the client is Brightwater Logistics", "confidence": "high"},
    {"field": "nonsense", "value": "x", "quote": "", "confidence": "low"}],
    "reply": "Got it: the client is Brightwater Logistics Ltd. What is the name of your firm?"}
REPLIES = {CHAT_SYSTEM: CHAT_REPLY, SCHEMA_SYSTEM: SCHEMA_REPLY, AUTHOR_SYSTEM: AUTHOR_REPLY, EXTRACT_SYSTEM: EXTRACT_REPLY, REVIEW_SYSTEM: REVIEW_REPLY}


class FakeMessages:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, **params: Any) -> Message:
        self.calls.append(params)
        return Message.model_validate({
            "id": "msg_test", "type": "message", "role": "assistant", "model": params["model"],
            "content": [{"type": "text", "text": json.dumps(REPLIES[params["system"]])}],
            "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 900, "output_tokens": 300}})


@pytest.fixture
def lab(tmp_path: Path) -> tuple[TestClient, FakeMessages]:
    messages = FakeMessages()
    fake = NS(messages=messages, beta=NS(messages=messages), models=NS(retrieve=lambda m: {"id": m}))
    settings = Settings(port=8000, frontend_dist=tmp_path, models_dir=tmp_path / "none", sites_dir=tmp_path / "sites")
    return TestClient(create_app(settings, client=fake, browser=NS(available=False)), base_url="http://localhost:8000"), messages


def upload(client: TestClient, content: bytes, mode: str, name: str = "file.docx") -> Any:
    return client.post("/api/documents/templates", data={"mode": mode}, files={"file": (name, content, DOCX)}, headers=LAB)


def test_a_template_gets_an_interview_and_assembles_deterministically(lab: Any) -> None:
    client, fake = lab
    r = upload(client, engagement_letter_template(), "template")
    assert r.status_code == 200, r.text
    t = r.json()
    names = [f["name"] for f in t["fields"]]
    assert names[0] == "client_name" and "not_in_template" not in names and len(names) == 16  # every variable, once
    kinds = {f["name"]: f["type"] for f in t["fields"]}
    assert kinds["fixed_fee"] == "boolean" and kinds["include_confidentiality"] == "boolean" and kinds["deliverables"] == "list"
    assert fake.calls[0]["output_config"]["format"]["type"] == "json_schema"

    answers = {"client_name": "Brightwater & Co", "fixed_fee": True, "fee_amount": "£4,500", "deliverables": "One\nTwo",
               "include_confidentiality": False, "start_date": "2026-11-03"}
    first = client.post(f"/api/documents/templates/{t['id']}/assemble", json={"answers": answers}, headers=LAB).json()
    second = client.post(f"/api/documents/templates/{t['id']}/assemble", json={"answers": answers}, headers=LAB).json()
    assert first["text"] == second["text"]  # the same answers, the same document
    text = first["text"]
    assert "Brightwater & Co" in text and "fixed fee of £4,500" in text and "3 November 2026" in text
    assert "hourly rate" not in text and "Confidentiality" not in text and "One\nTwo" in text
    assert "Firm name" in " ".join(first["missing"])  # required answers left empty are listed
    download = client.get(f"/api/documents/assembled/{first['id']}", headers=LAB)
    assert "Brightwater & Co" in "\n".join(p.text for p in Document(io.BytesIO(download.content)).paragraphs)


def test_ai_turns_a_finished_document_into_a_template(lab: Any) -> None:
    client, _ = lab
    t = upload(client, finished_nda(), "author", "nda.docx").json()
    assert "{{ party_a_name }}" in t["text"] and "{{ agreement_date }}" in t["text"]
    assert "Northwind Traders Limited" not in t["text"] and "{{ party_a_short_name }}" in t["text"]
    assert "{%p if include_non_solicitation %}" in t["text"]
    assert "the law of {{ governing_law }}" in t["text"] and "registered in {{ registration_jurisdiction }}" in t["text"]
    assert [m["text"] for m in t["not_found"]] == ["text that is not there"]
    kinds = {f["name"]: f["type"] for f in t["fields"]}
    assert kinds["include_non_solicitation"] == "boolean" and kinds["agreement_date"] == "date"
    without = client.post(f"/api/documents/templates/{t['id']}/assemble", headers=LAB, json={"answers": {
        "party_a_name": "Fabrikam Ltd", "party_a_short_name": "Fabrikam", "include_non_solicitation": False}}).json()["text"]
    assert "Fabrikam Ltd" in without and "solicit" not in without
    with_clause = client.post(f"/api/documents/templates/{t['id']}/assemble", headers=LAB, json={"answers": {
        "include_non_solicitation": True}}).json()["text"]
    assert "neither party will solicit" in with_clause
    assert client.get(f"/api/documents/templates/{t['id']}/file", headers=LAB).headers["content-type"] == DOCX


def test_answers_come_from_sources_with_quotes_and_unknown_fields_are_dropped(lab: Any) -> None:
    client, fake = lab
    t = upload(client, engagement_letter_template(), "template").json()
    r = client.post(f"/api/documents/templates/{t['id']}/extract", headers=LAB, data={"note": "See the email."},
                    files=[("files", ("intake.txt", b"Hi James, Brightwater Logistics Ltd...", "text/plain")),
                           ("files", ("terms.pdf", b"%PDF-1.4 fake", "application/pdf"))]).json()
    assert [a["field"] for a in r["answers"]] == ["client_name", "start_date"]
    content = fake.calls[-1]["messages"][0]["content"]
    assert content[0]["text"].startswith("Source document intake.txt") and content[1]["type"] == "document"
    assert "client_name (text)" in content[-1]["text"]


def test_the_assembled_document_can_be_reviewed(lab: Any) -> None:
    client, _ = lab
    t = upload(client, engagement_letter_template(), "template").json()
    doc = client.post(f"/api/documents/templates/{t['id']}/assemble", json={"answers": {}}, headers=LAB).json()
    r = client.post(f"/api/documents/assembled/{doc['id']}/review", json={}, headers=LAB).json()
    assert r["issues"][0]["severity"] == "medium" and r["summary"]


def test_bad_uploads_and_unknown_ids_are_refused(lab: Any) -> None:
    client, _ = lab
    assert upload(client, b"not a docx", "template", "notes.txt").status_code == 400
    assert upload(client, finished_nda(), "template").status_code == 400  # no {{ fields }}: use AI authoring
    assert client.post("/api/documents/templates/nope/assemble", json={"answers": {}}, headers=LAB).status_code == 404
    assert client.get("/api/documents/samples/intake-email.txt", headers=LAB).text.startswith("From: Sarah Mitchell")
    assert client.get("/api/documents/samples/secret.docx", headers=LAB).status_code == 404


def test_an_optional_clause_named_by_its_heading_takes_its_text_too(lab: Any) -> None:
    client, _ = lab
    REPLIES[AUTHOR_SYSTEM] = {**AUTHOR_REPLY, "optional_clauses": [
        {"starts_with": "4. Non-solicitation", "field": "include_non_solicitation"},
        {"starts_with": "For 12 months after this Agreement ends, neither party", "field": "include_non_solicitation"}],  # the same clause twice
                              "replacements": [*AUTHOR_REPLY["replacements"], {"text": "12 months", "field": "non_solicitation_period", "within": ""}]}
    try:
        t = upload(client, finished_nda(), "author", "nda.docx").json()
    finally:
        REPLIES[AUTHOR_SYSTEM] = AUTHOR_REPLY
    lines = t["text"].splitlines()
    assert lines.count("{%p if include_non_solicitation %}") == 1 and len(t["optional_clauses"]) == 1
    start = lines.index("{%p if include_non_solicitation %}")
    assert lines[start + 1] == "4. Non-solicitation" and "{{ non_solicitation_period }}" in lines[start + 2]
    assert lines[start + 3] == "{%p endif %}"
    text = client.post(f"/api/documents/templates/{t['id']}/assemble", headers=LAB,
                       json={"answers": {"include_non_solicitation": False}}).json()["text"]
    assert "Non-solicitation" not in text and "5. Governing law" in text


def test_the_interview_can_be_filled_by_talking(lab: Any) -> None:
    client, fake = lab
    t = upload(client, engagement_letter_template(), "template").json()
    r = client.post(f"/api/documents/templates/{t['id']}/chat", headers=LAB, data={
        "message": "The client is Brightwater Logistics", "answers": json.dumps({"fee_amount": "£4,500"}),
        "history": json.dumps([{"role": "assistant", "text": "Who is the client?"}])},
        files=[("files", ("intake.txt", b"From: Sarah at Brightwater", "text/plain"))]).json()
    assert [a["field"] for a in r["answers"]] == ["client_name"] and r["reply"].startswith("Got it")
    blocks = fake.calls[-1]["messages"][0]["content"]
    assert blocks[0]["text"].startswith("Source document intake.txt")  # an attached document comes first
    sent = blocks[-1]["text"]
    assert '"£4,500"' in sent  # current values are shown to Claude
    assert "client_name" in sent and "(empty)" in sent and "assistant: Who is the client?" in sent
    assert sent.rstrip().endswith("The client is Brightwater Logistics")


def test_the_preview_marks_answered_and_empty_fields(lab: Any) -> None:
    client, _ = lab
    t = upload(client, engagement_letter_template(), "template").json()
    text = client.post(f"/api/documents/templates/{t['id']}/preview", headers=LAB, json={"answers": {
        "client_name": "Brightwater & Co", "fixed_fee": True, "start_date": "2026-11-03", "deliverables": "One\nTwo"}}).json()["text"]
    assert "⟦Brightwater & Co⟧" in text and "⟦3 November 2026⟧" in text and "⟦One⟧\n⟦Two⟧" in text
    assert "⟦?Client's name⟧" not in text and "⟦?Firm name⟧" in text  # an empty field shows its question
    assert "fixed fee of ⟦?Fee amount⟧" in text and "hourly rate" not in text  # the IF follows the answers


def test_a_message_needs_text_or_a_document(lab: Any) -> None:
    client, fake = lab
    t = upload(client, engagement_letter_template(), "template").json()
    calls = len(fake.calls)
    r = client.post(f"/api/documents/templates/{t['id']}/chat", headers=LAB, data={"message": "  "})
    assert r.status_code == 400 and len(fake.calls) == calls
    only_file = client.post(f"/api/documents/templates/{t['id']}/chat", headers=LAB, data={"message": ""},
                            files=[("files", ("notes.txt", b"Client: Brightwater", "text/plain"))])
    assert only_file.status_code == 200
    assert "fill in what you can from the attached documents" in fake.calls[-1]["messages"][0]["content"][-1]["text"]


class FakeGPT:
    """Stands in for the Azure OpenAI gateway: records each call and gives a fixed structured answer."""
    models = ["gpt-5.4-mini"]

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def structured(self, model: str, system: str, schema: dict, content: Any, max_tokens: int) -> tuple[dict, Any]:
        self.calls.append({"model": model, "system": system, "schema": schema, "content": content})
        answer = {"answers": [{"field": "client_name", "value": "Brightwater Logistics Ltd", "quote": "Brightwater",
                               "confidence": "high"}], "reply": "Got it. What is the start date?"}
        return answer, NS(input_tokens=1000, cache_read_input_tokens=0, cache_creation_input_tokens=0, output_tokens=100)


def test_a_gpt_deployment_can_fill_the_interview_instead_of_claude(tmp_path: Path) -> None:
    messages, gpt = FakeMessages(), FakeGPT()
    fake = NS(messages=messages, beta=NS(messages=messages), models=NS(retrieve=lambda m: {"id": m}))
    settings = Settings(port=8000, frontend_dist=tmp_path, models_dir=tmp_path / "none", sites_dir=tmp_path / "sites")
    client = TestClient(create_app(settings, client=fake, browser=NS(available=False), gpt=gpt), base_url="http://localhost:8000")
    assert client.get("/api/status", headers=LAB).json()["gpt_models"] == ["gpt-5.4-mini"]

    t = upload(client, engagement_letter_template(), "template").json()  # Claude writes the interview
    claude_calls = len(messages.calls)
    r = client.post(f"/api/documents/templates/{t['id']}/chat", headers=LAB,
                    data={"message": "The client is Brightwater", "model": "gpt-5.4-mini"},
                    files=[("files", ("intake.txt", b"From: Sarah at Brightwater", "text/plain"))])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["answers"][0]["value"] == "Brightwater Logistics Ltd" and body["reply"].startswith("Got it")
    assert len(messages.calls) == claude_calls  # GPT answered; Claude was not called
    call = gpt.calls[-1]
    assert call["system"] == CHAT_SYSTEM and call["content"][0]["text"].startswith("Source document intake.txt")
    assert body["cost"] == pytest.approx((1000 * 0.75 + 100 * 4.50) / 1e6)  # charged at GPT's prices

    unknown = client.post(f"/api/documents/templates/{t['id']}/chat", headers=LAB, data={"message": "hi", "model": "gpt-9"})
    assert unknown.status_code == 400 and "gpt-5.4-mini" in unknown.json()["error"]["message"]


def test_claude_content_blocks_become_openai_parts() -> None:
    from backend.app.gateways.azure_openai import to_openai
    parts = to_openai([{"type": "document", "title": "a.pdf", "source": {"type": "base64", "media_type": "application/pdf", "data": "QUJD"}},
                       {"type": "text", "text": "Fill it in"}])
    assert parts == [{"type": "file", "file": {"filename": "a.pdf", "file_data": "data:application/pdf;base64,QUJD"}},
                     {"type": "text", "text": "Fill it in"}]
