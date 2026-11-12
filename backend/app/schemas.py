"""The request bodies the pages may send. Anything not listed is dropped or rejected."""
from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

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


class AftercareStart(ModelChoice):
    """A follow-up call to one discharged patient. The worklist picks the patient, never the model."""
    patient_id: str = Field(pattern=r"^P1\d\d$")
    engine: Literal["claude", "agent-framework"] = "claude"


class AftercareMessage(BaseModel):
    message: str = Field(min_length=1, max_length=1000)


class DietStart(ModelChoice):
    user: str = Field(default="guest", max_length=60)
    consent: bool = False  # may the agent remember health details (allergies, conditions, weight, height)


class DietMessage(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class WhiteboardRead(ModelChoice):
    image: str = Field(min_length=100, max_length=6_000_000)  # the board as a base64 PNG
    prompt: str = Field(default="", max_length=1000)


class WhiteboardAsk(ModelChoice):
    question: str = Field(min_length=1, max_length=2000)
    board: dict = Field(default_factory=dict)  # what the board shows, as the read returned it


class HotelMessage(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class HotelFrontDesk(BaseModel):
    type_code: Literal["STD", "TWN", "SEA", "FAM", "STE"]
    check_in: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    check_out: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class AftercareTaskClose(BaseModel):
    note: str = Field(default="Done", max_length=300)


class AftercareEvaluate(ModelChoice):
    engine: Literal["claude", "agent-framework"] = "claude"
    patients: list[str] = Field(default_factory=lambda: ["P101", "P102", "P103", "P104", "P105", "P106", "P107", "P108"],
                                min_length=1, max_length=8)

    @field_validator("patients")
    @classmethod
    def known_patients(cls, value: list[str]) -> list[str]:
        if any(not re.fullmatch(r"P10[1-8]", p) for p in value):
            raise ValueError("Choose from P101 to P108")
        return list(dict.fromkeys(value))


class GuardText(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class GuardShield(BaseModel):
    prompt: str = Field(min_length=1, max_length=5000)
    documents: list[str] = Field(default_factory=list, max_length=5)


class GuardGrounded(BaseModel):
    answer: str = Field(min_length=1, max_length=5000)
    query: str = Field(default="", max_length=1000)
    source: str = Field(default="", max_length=10000)


class GuardImage(BaseModel):
    """A sample image by id, or the page's own image as base64 (PNG or JPEG, up to about 4 MB)."""
    image_id: str = Field(default="", max_length=20)
    data: str = Field(default="", max_length=6_000_000)
    question: str = Field(default="What does this image show?", min_length=1, max_length=500)


class GuardPipeline(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    document: str = Field(default="", max_length=10000)
    threshold: int = Field(default=4, ge=1, le=7)


class GuardEvaluate(BaseModel):
    threshold: int = Field(default=4, ge=1, le=7)


class UnderstandAnalyze(BaseModel):
    sample: str = Field(min_length=1, max_length=30)
    analyzer: str = Field(min_length=1, max_length=40)


class UnderstandVision(BaseModel):
    images: list[str] = Field(min_length=1, max_length=4)
    task: str = Field(min_length=1, max_length=20)
    question: str = Field(default="", max_length=500)


class ImageGenerate(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    size: Literal["1024x1024", "1536x1024", "1024x1536"] = "1024x1024"
    quality: Literal["low", "medium", "high"] = "low"
    background: Literal["auto", "opaque", "transparent"] = "auto"
    n: int = Field(default=1, ge=1, le=2)


class ImageEdit(BaseModel):
    """Reference images by id (or sample:<name>), and optionally a mask as a PNG data URL: transparent means change."""
    prompt: str = Field(min_length=1, max_length=4000)
    images: list[str] = Field(min_length=1, max_length=4)
    mask: str = Field(default="", max_length=8_000_000)
    size: Literal["1024x1024", "1536x1024", "1024x1536"] = "1024x1024"
    quality: Literal["low", "medium", "high"] = "low"


class ImageRef(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(default="AI-generated", max_length=40)


class SearchQuery(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    mode: Literal["keyword", "vector", "hybrid", "semantic"] = "hybrid"


class SearchAsk(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class TranslateText(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    targets: list[str] = Field(min_length=1, max_length=8)
    glossary: bool = True
    profanity: Literal["NoAction", "Marked", "Deleted"] = "NoAction"


class TranslateLlm(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    target: str = Field(min_length=2, max_length=10)
    tone: str = Field(default="formal and warm", max_length=80)
    glossary: bool = True


class Transliterate(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    language: str = Field(max_length=10)
    from_script: str = Field(max_length=10)
    to_script: str = Field(max_length=10)


class DictionaryLookup(BaseModel):
    word: str = Field(min_length=1, max_length=100)
    source: str = Field(default="en", max_length=10)
    target: str = Field(default="es", max_length=10)


class AudioQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class TraceRequest(BaseModel):
    question: str = Field(default="Is the kitchen leak covered?", min_length=1, max_length=500)


class DataAsk(ModelChoice):
    question: str = Field(min_length=1, max_length=2000)
    session_id: str | None = Field(default=None, max_length=40)


class DataQuery(BaseModel):
    """A query from the field picker, in the same shape the agent's run_query tool takes."""
    topic: str = Field(max_length=40)
    dimensions: list[str] = Field(default_factory=list, max_length=6)
    measures: list[str] = Field(default_factory=list, max_length=8)
    filters: list[dict[str, Any]] = Field(default_factory=list, max_length=10)
    sorts: list[dict[str, Any]] = Field(default_factory=list, max_length=4)
    limit: int = Field(default=500, ge=1, le=5000)
    custom_fields: list[dict[str, Any]] = Field(default_factory=list, max_length=12)  # fields the agent made


class DataSql(BaseModel):
    """SQL typed or edited in the workbook's SQL tab. It runs under the same checks as the agent's run_sql."""
    sql: str = Field(min_length=1, max_length=8000)
    limit: int = Field(default=500, ge=1, le=5000)


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


class TokenCompareRequest(BaseModel):
    system: str = Field(default="", max_length=50000)
    prompt: str = Field(min_length=1, max_length=50000)


class TokenCountRequest(TokenCompareRequest):
    """One model from the token counter's catalogue (services/token_counter.py), which checks the id."""
    model: str = Field(min_length=1, max_length=100)


class TokenBreakdownRequest(BaseModel):
    """A prompt to measure word by word, on any model the lab offers: Claude, a GPT deployment or the local model."""
    model: str = "claude-haiku-5-5"
    system: str = Field(default="", max_length=20000)
    prompt: str = Field(min_length=1, max_length=20000)

    @field_validator("model")
    @classmethod
    def known_model(cls, value: str) -> str:
        if value not in MODELS and not value.startswith("claude-"):  # earlier Claude models can be counted too
            raise ValueError(f"Model must be one of: {', '.join(MODELS)}, or another Claude model")
        return value


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


class ReviewsAnalyze(BaseModel):
    """Leave both out to analyse every sample review."""
    ids: list[str] | None = Field(None, max_length=50)
    text: str | None = Field(None, min_length=1, max_length=5000)


class ReviewsCompare(ModelChoice):
    id: str | None = Field(None, max_length=20)
    text: str | None = Field(None, min_length=1, max_length=5000)


class HarnessRequest(ModelChoice):
    scenario: Literal["chain", "parallel", "team", "bash", "web"] = "chain"
    number: int = Field(12, ge=2, le=1_000_000)
    task: str | None = Field(None, max_length=500)
    effort: Literal["low", "medium", "high"] = "low"


JPEG_DATA = r"^data:image/jpeg;base64,[A-Za-z0-9+/=]+$"


class CameraConsent(BaseModel):
    by: str = Field(min_length=2, max_length=120)
    agreed: Literal[True]


class CameraAnalyse(BaseModel):
    frames: list[Annotated[str, StringConstraints(pattern=JPEG_DATA, max_length=300_000)]] = Field(min_length=1, max_length=4)
    descriptor: list[float] | None = Field(default=None, min_length=128, max_length=128)
    thumbnail: Annotated[str, StringConstraints(pattern=JPEG_DATA, max_length=40_000)] | None = None
    layout: str | None = Field(default=None, max_length=300)


class CameraDoor(BaseModel):
    descriptor: list[float] = Field(min_length=128, max_length=128)
    threshold: float = Field(default=80, ge=50, le=99)


class ComplianceRequest(BaseModel):
    controller: str = Field(min_length=2, max_length=120)
    lawful_basis: str = Field(min_length=5, max_length=400)
    dpia_reference: str = Field(min_length=2, max_length=120)
    signage: bool


class ReviewRequest(BaseModel):
    reviewer: str = Field(min_length=2, max_length=120)
    theft: bool
    note: str = Field(default="", max_length=1000)
    watched_footage: bool = False


class DoorRequest(BaseModel):
    threshold: float = Field(default=80, ge=50, le=99)


class MatchDecision(BaseModel):
    staff: str = Field(min_length=2, max_length=120)
    same_person: bool


class RemoveEntry(BaseModel):
    by: str = Field(min_length=2, max_length=120)
    reason: str = Field(min_length=3, max_length=400)


class WorkflowRequest(BaseModel):
    pattern: str = Field(max_length=40)
    task: str | None = Field(default=None, max_length=2000)


class ApproveRequest(BaseModel):
    run_id: str
    tool_use_id: str
    allow: bool


class CodingRun(BaseModel):
    """A request for the coding agent. Without a session_id, it starts on a fresh copy of the project. The model is
    a Claude model, the local model or a GPT deployment (gpt-...); the service checks it is one the lab has."""
    model: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/\-]*$", max_length=60)
    prompt: str = Field(min_length=1, max_length=4000)
    session_id: str | None = Field(default=None, max_length=40)
    mode: Literal["default", "accept_edits", "plan", "bypass", "auto"] = "default"


class CodingSession(BaseModel):
    workspace: Literal["practice", "files"] = "practice"


class CodingSdkRun(ModelChoice):
    """The same request for the Agent SDK version, which always starts on a fresh copy."""
    prompt: str = Field(min_length=1, max_length=4000)
    mode: Literal["default", "accept_edits", "plan", "bypass", "auto"] = "default"


class SkillsRequest(ModelChoice):
    skill: Literal["xlsx", "pptx", "docx", "pdf"] = "xlsx"
    upto: int = Field(20, ge=2, le=200)
