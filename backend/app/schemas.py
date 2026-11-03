"""The request bodies the pages may send. Anything not listed is dropped or rejected."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .settings import MODELS
from .shared import DEFAULT_MODEL


class ModelChoice(BaseModel):
    model: str | None = None

    @field_validator("model")
    @classmethod
    def known_model(cls, value: str | None) -> str | None:
        if value and value not in MODELS:
            raise ValueError(f"Model must be one of: {', '.join(MODELS)}")
        return value


class SiteTurnRequest(ModelChoice):
    """One message to the site builder. Leave site_id out to start a new site."""
    site_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{12}$")
    prompt: str = Field(min_length=1, max_length=4000)


class DocumentChatLine(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=4000)


class CaseDecision(BaseModel):
    """A caseworker's decision on a drafted response: approve (optionally edited) or reject."""
    action: Literal["approve", "reject"]
    reviewer: str = Field(min_length=2, max_length=80)
    letter: str = Field(default="", max_length=20000)
    note: str = Field(default="", max_length=2000)


class MedAssistStart(BaseModel):
    """Who is signed in to the MedAssist portal. The patient is chosen here, never by the model."""
    patient_id: str = Field(pattern=r"^P\d{3}$")


class MedAssistMessage(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class McpAskRequest(ModelChoice):
    """A question for Claude to answer with the MCP lab server's tools."""
    task: str = Field(min_length=1, max_length=2000)
    allow_writes: bool = False


class DocumentModelChoice(BaseModel):
    """A Claude model or a GPT deployment; the document service checks which are available."""
    model: str | None = Field(default=None, max_length=64)


class DocumentChatRequest(DocumentModelChoice):
    """One message of filling the interview by talking, with the answers so far."""
    message: str = Field(min_length=1, max_length=4000)
    answers: dict[str, str | bool | list[str] | None] = Field(default_factory=dict, max_length=200)
    history: list[DocumentChatLine] = Field(default_factory=list, max_length=40)


class AssembleRequest(BaseModel):
    """The interview's answers: text, booleans, or lists for repeated items."""
    answers: dict[str, str | bool | list[str] | None] = Field(default_factory=dict, max_length=200)


class SiteRestoreRequest(BaseModel):
    """Restore a site to before its message number `keep` (0 is the first)."""
    keep: int = Field(ge=0, le=10_000)


class TutorImage(BaseModel):
    """A picture the learner shares, such as homework or a screenshot, as base64."""
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data: str = Field(min_length=1, max_length=7_000_000)  # base64 of up to 5 MB


class TutorLine(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=12000)  # a written explanation can be long
    images: list[TutorImage] = Field(default_factory=list, max_length=3)


class WordScore(BaseModel):
    word: str = Field(max_length=60)
    accuracy: float | None = Field(default=None, ge=0, le=100)
    error: str | None = Field(default=None, max_length=30)


class PronunciationScores(BaseModel):
    """Azure's pronunciation assessment of what the learner said, measured in the browser."""
    accuracy: float | None = Field(default=None, ge=0, le=100)
    fluency: float | None = Field(default=None, ge=0, le=100)
    prosody: float | None = Field(default=None, ge=0, le=100)
    completeness: float | None = Field(default=None, ge=0, le=100)
    words: list[WordScore] = Field(default_factory=list, max_length=1000)  # a long spoken turn can have hundreds


class TutorTurnRequest(ModelChoice):
    """One thing the learner said or showed, with the conversation so far, kept by the page."""
    message: str = Field(default="", max_length=12000)  # minutes of speech, or a pasted document such as a job advert
    images: list[TutorImage] = Field(default_factory=list, max_length=3)
    history: list[TutorLine] = Field(default_factory=list, max_length=80)
    subject: str = Field(default="english", pattern=r"^[a-z_]{2,20}$")
    subject_name: str = Field(default="", max_length=40, pattern=r"^[\w ,&()'+.-]*$")  # when subject is other
    stage: Literal["primary", "secondary", "sixth_form", "university", "adult"] = "secondary"
    style: Literal["explain", "hints"] = "explain"
    level: Literal["auto", "A1", "A2", "B1", "B2", "C1", "C2"] = "auto"  # English only
    native_language: str = Field(default="", max_length=40, pattern=r"^[\w ()'-]*$")
    scenario: Literal["chat", "interview", "restaurant", "travel", "ielts", "school"] = "chat"
    spoken: bool = False
    pronunciation: PronunciationScores | None = None
    tutor_name: str = Field(default="Alex", pattern=r"^[A-Z][a-z]{1,19}$")  # the person the learner talks to
    coaching: bool = True  # English: after each answer, say how to make it stronger
    interview_brief: str = Field(default="", max_length=8000)  # the job interview scenario: the role and company


class MessagesRequest(ModelChoice):
    """The subset of Messages API parameters the pages may send."""
    model_config = ConfigDict(extra="ignore")

    max_tokens: int | None = None
    system: str | list[dict[str, Any]] | None = None
    messages: list[dict[str, Any]] = Field(min_length=1)
    tools: list[dict[str, Any]] | None = None
    tool_choice: dict[str, Any] | None = None
    output_config: dict[str, Any] | None = None
    cache_control: dict[str, Any] | None = None
    stop_sequences: list[str] | None = None

    def params(self, cap: int) -> dict[str, Any]:
        out = self.model_dump(exclude_none=True)
        out["model"] = self.model or DEFAULT_MODEL
        out["max_tokens"] = max(1, min(self.max_tokens or 4096, cap))
        return out


class HarnessRequest(ModelChoice):
    scenario: Literal["chain", "parallel", "team", "bash", "web"] = "chain"
    number: int = Field(12, ge=2, le=1_000_000)
    task: str | None = Field(None, max_length=500)
    effort: Literal["low", "medium", "high"] = "low"


class ApproveRequest(BaseModel):
    run_id: str
    tool_use_id: str
    allow: bool


class SkillsRequest(ModelChoice):
    skill: Literal["xlsx", "pptx", "docx", "pdf"] = "xlsx"
    upto: int = Field(20, ge=2, le=200)
