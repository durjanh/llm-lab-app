"""The composition root: the one place that builds the services and wires them together.

Routes ask for a service through FastAPI's Depends (see api/deps.py) and never build one
themselves, so tests can hand in a fake Claude client and nothing else changes.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .gateways.agent_framework import AgentFramework, FrameworkAgents
from .gateways import hotel_notify
from .gateways.hf_tokenizers import HfTokenizers
from .gateways.agent_workflows import AgentWorkflows, WorkflowRunner
from .gateways.azure_language import AzureLanguage, TextAnalyzer
from .gateways.azure_openai import AzureOpenAI, StructuredModel
from .gateways.azure_search import AzureSearch
from .gateways.azure_speech import AzureSpeech, SpeechTokens
from .gateways.browser import ChromeScreenshotter, Screenshotter
from .gateways.claude import ClaudeGateway
from .gateways.foundry_agent import AgentConversations, FoundryAgent
from .gateways.foundry_tools import FoundryTools
from .services.aftercare import AftercareService
from .services.aftercare_phone import AftercarePhone
from .services.diet import DietService
from .services.hotel import HotelService
from .services.token_counter import TokenCounterService
from .services.medassist_phone import MedAssistPhone
from .services.transcripts import TranscriptArchive
from .shared import translator as shared_translator
from .gateways.phone import CallAutomation, PhoneLine
from .services.casework import CaseworkService
from .services.coding import CodingService
from .services.dataagent import DataAgentService
from .services.decks import DeckChats, DeckService
from .services.documents import DocumentService
from .services.foundryops import FoundryOpsService
from .services.guardrails import GuardrailsService
from .services.translate import TranslateService
from .services.searchlab import SearchLabService
from .services.imagegen import ImageGenService
from .services.understanding import UnderstandingService
from .services.mcp_lab import McpLab
from .services.medassist import MedAssistService
from .shared import medassist_sms
from .services.harness import HarnessService
from .services.messages import MessagesService
from .services.reviews import ReviewsService
from .services.runs import RunRegistry, RunStreamer
from .services.sites import SiteService, SiteStore
from .services.skills import MadeFiles, SkillsService
from .services.spend import SpendTracker
from .services.status import StatusService
from .services.tutor import TutorService
from .services.storewatch import StoreWatchService
from .services.workflows import WorkflowService
from .settings import Settings


@dataclass(frozen=True)
class Container:
    settings: Settings
    spend: SpendTracker
    status: StatusService
    messages: MessagesService
    harness: HarnessService
    skills: SkillsService
    workflows: WorkflowService
    storewatch: StoreWatchService
    decks: DeckService
    sites: SiteService
    tutor: TutorService
    documents: DocumentService
    mcp_lab: McpLab
    casework: CaseworkService
    medassist: MedAssistService
    reviews: ReviewsService
    aftercare: AftercareService
    aftercare_phone: AftercarePhone
    hotel: HotelService
    diet: DietService
    token_counter: TokenCounterService
    medassist_phone: MedAssistPhone
    guardrails: GuardrailsService
    understanding: UnderstandingService
    imagegen: ImageGenService
    searchlab: SearchLabService
    translate: TranslateService
    foundryops: FoundryOpsService
    dataagent: DataAgentService
    coding: CodingService
    runs: RunRegistry

    @classmethod
    def build(cls, settings: Settings, client: Any, browser: Screenshotter | None = None,
              speech: SpeechTokens | None = None, gpt: StructuredModel | None = None,
              search: AzureSearch | None = None, foundry: AgentConversations | None = None,
              language: TextAnalyzer | None = None, agents: FrameworkAgents | None = None,
              tools: FoundryTools | None = None, phone: PhoneLine | None = None,
              workflows: WorkflowRunner | None = None) -> "Container":
        claude = ClaudeGateway(client)
        spend = SpendTracker(settings.budget_usd)
        registry = RunRegistry()
        streamer = RunStreamer(registry, settings.heartbeat_s)
        skills = SkillsService(claude, spend, streamer, MadeFiles())
        if gpt is None and settings.azure_openai_endpoint and settings.azure_openai_deployments:
            gpt = AzureOpenAI(settings.azure_openai_endpoint, list(settings.azure_openai_deployments),
                              settings.azure_openai_embedding_deployment)
        if foundry is None and settings.foundry_project_endpoint and settings.foundry_model:
            foundry = FoundryAgent(settings.foundry_project_endpoint, settings.foundry_model)
        if agents is None and settings.foundry_project_endpoint and settings.foundry_model:
            agents = AgentFramework(settings.foundry_project_endpoint, settings.foundry_model)
        if workflows is None and settings.azure_openai_endpoint and settings.azure_openai_deployments:
            workflows = AgentWorkflows(settings.azure_openai_endpoint, settings.azure_openai_deployments[0])
        if search is None and settings.azure_search_endpoint:
            search = AzureSearch(settings.azure_search_endpoint)
        if tools is None and settings.azure_language_endpoint:
            tools = FoundryTools(settings.azure_language_endpoint, settings.azure_media_endpoint,
                                 settings.azure_ai_resource_id, settings.azure_media_resource_id)
        if language is None and settings.azure_language_endpoint:
            language = AzureLanguage(settings.azure_language_endpoint)
        understanding = UnderstandingService(tools, spend, settings.generated_dir / "understanding")
        archive = TranscriptArchive(settings.generated_dir / "transcripts")  # every conversation, kept
        # Live translation (calls and texts), through the lab's AI Services account; none without it.
        translate = shared_translator.Translator(settings.azure_language_endpoint) if settings.azure_language_endpoint else None
        override = {settings.medassist_phone_patient: settings.medassist_phone_language} \
            if settings.medassist_phone_language else {}
        aftercare = AftercareService(claude, agents, spend, streamer, settings.aftercare_db, archive)
        acs = settings.medassist_sms_endpoint  # one Communication Services resource sends texts and makes calls
        needed = {"AFTERCARE_CALL_TO": settings.aftercare_call_to, "AFTERCARE_CALLER_ID": settings.aftercare_caller_id,
                  "AFTERCARE_CALLBACK_URL": settings.aftercare_callback_url, "MEDASSIST_SMS_ENDPOINT": acs,
                  "AZURE_LANGUAGE_ENDPOINT": settings.aftercare_speech_endpoint}
        missing = [k for k, v in needed.items() if not v] if phone is None else []
        if phone is None and not missing:
            phone = CallAutomation(acs, medassist_sms.e164(settings.aftercare_caller_id), settings.aftercare_speech_endpoint)
        to = medassist_sms.e164(settings.aftercare_call_to) if settings.aftercare_call_to else ""
        medassist = MedAssistService(foundry, spend, settings.medassist_db, medassist_sms.from_settings(
            settings.medassist_sms_endpoint, settings.medassist_sms_sender, settings.medassist_sms_to,
            settings.medassist_reminders_table, translate), archive, override)
        line_missing = missing + ([] if settings.medassist_phone_token else ["MEDASSIST_PHONE_TOKEN"])
        medassist_line = MedAssistPhone(medassist, phone, to, settings.medassist_phone_patient,
                                        settings.aftercare_callback_url, settings.medassist_phone_token,
                                        spoken_date_reader(claude), line_missing, archive, translate,
                                        settings.medassist_phone_language)
        return cls(
            settings=settings,
            spend=spend,
            status=StatusService(claude, spend, gpt.models if gpt else []),
            messages=MessagesService(claude, spend),
            harness=HarnessService(claude, spend, registry, streamer, run_budget_usd=settings.run_budget_usd,
                                   approval_timeout_s=settings.approval_timeout_s),
            workflows=WorkflowService(workflows, spend, registry, streamer, run_budget_usd=settings.run_budget_usd,
                                      approval_timeout_s=settings.approval_timeout_s),
            storewatch=StoreWatchService(settings.generated_dir / "storewatch" / "storewatch.db", gpt=gpt, spend=spend),
            skills=skills,
            decks=DeckService(claude, spend, streamer, skills, DeckChats()),
            sites=SiteService(claude, spend, streamer, SiteStore(settings.sites_dir),
                              browser or ChromeScreenshotter(settings.chrome_path or None), settings.origin),
            tutor=TutorService(claude, spend, streamer,
                               speech or AzureSpeech(settings.azure_speech_key, settings.azure_speech_region,
                                                     settings.azure_speech_resource_id,
                                                     settings.azure_speech_fallback_resource_id)),
            documents=DocumentService(claude, spend, gpt),
            mcp_lab=McpLab(claude, spend, settings.origin, settings.allowed_hosts),
            casework=CaseworkService(gpt, search, spend, settings.casework_dir),
            medassist=medassist,
            medassist_phone=medassist_line,
            reviews=ReviewsService(language, claude, spend),
            aftercare=aftercare,
            token_counter=TokenCounterService(claude, HfTokenizers(settings.generated_dir / "tokenizers")),
            hotel=HotelService(claude, spend, settings.generated_dir / "hotel" / "hotel.db", hotel_notify.from_settings(
                settings.medassist_sms_endpoint, settings.medassist_sms_sender, settings.hotel_sms_to,
                settings.hotel_email_sender, settings.hotel_email_to)),
            diet=DietService(claude, spend, settings.generated_dir / "diet-memory"),
            aftercare_phone=AftercarePhone(aftercare, phone, to, settings.aftercare_callback_url, missing, archive,
                                           translate),
            guardrails=GuardrailsService(tools, spend),
            understanding=understanding,
            translate=TranslateService(tools, spend, understanding),
            foundryops=FoundryOpsService(tools, search, spend),
            dataagent=DataAgentService(claude, spend, streamer, settings.generated_dir / "data-agent"),
            coding=CodingService(claude, spend, registry, streamer, settings.generated_dir / "coding-agent", gpt=gpt,
                                 run_budget_usd=settings.run_budget_usd, approval_timeout_s=settings.approval_timeout_s),
            searchlab=SearchLabService(tools, search, understanding, spend, settings.generated_dir / "search"),
            imagegen=ImageGenService(tools, spend, settings.generated_dir / "images", settings.generated_dir / "understanding"),
            runs=registry,
        )


def spoken_date_reader(claude: ClaudeGateway):
    """Turns a spoken date of birth ("the third of March, nineteen eighty") into YYYY-MM-DD, or None. Only reading:
    the phone line compares the result with the record in code."""
    import json
    import re
    from datetime import date

    from .shared import DEFAULT_MODEL, text_of

    schema = {"type": "object", "properties": {"date_of_birth": {"type": ["string", "null"]}},
              "required": ["date_of_birth"], "additionalProperties": False}

    def read(heard: str) -> str | None:
        try:
            r = claude.create(model=DEFAULT_MODEL, max_tokens=60, messages=[{"role": "user", "content": (
                f"Today is {date.today().isoformat()}. A caller was asked for their date of birth and said: \"{heard}\". "
                "Give that date as YYYY-MM-DD, or null if they did not say a whole date.")}],
                output_config={"format": {"type": "json_schema", "schema": schema}})
            value = json.loads(text_of(r)).get("date_of_birth")
        except Exception:  # noqa: BLE001  (no model, a reply that is not JSON): treated as no date
            return None
        return value if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None

    return read
