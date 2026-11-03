"""The composition root: the one place that builds the services and wires them together.

Routes ask for a service through FastAPI's Depends (see api/deps.py) and never build one
themselves, so tests can hand in a fake Claude client and nothing else changes.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .gateways.agent_framework import AgentFramework, FrameworkAgents
from .gateways.azure_language import AzureLanguage, TextAnalyzer
from .gateways.azure_openai import AzureOpenAI, StructuredModel
from .gateways.azure_search import AzureSearch
from .gateways.azure_speech import AzureSpeech, SpeechTokens
from .gateways.browser import ChromeScreenshotter, Screenshotter
from .gateways.claude import ClaudeGateway
from .gateways.foundry_agent import AgentConversations, FoundryAgent
from .services.aftercare import AftercareService
from .services.casework import CaseworkService
from .services.decks import DeckChats, DeckService
from .services.documents import DocumentService
from .services.mcp_lab import McpLab
from .services.medassist import MedAssistService
from .services.harness import HarnessService
from .services.messages import MessagesService
from .services.reviews import ReviewsService
from .services.runs import RunRegistry, RunStreamer
from .services.sites import SiteService, SiteStore
from .services.skills import MadeFiles, SkillsService
from .services.spend import SpendTracker
from .services.status import StatusService
from .services.tutor import TutorService
from .settings import Settings


@dataclass(frozen=True)
class Container:
    settings: Settings
    spend: SpendTracker
    status: StatusService
    messages: MessagesService
    harness: HarnessService
    skills: SkillsService
    decks: DeckService
    sites: SiteService
    tutor: TutorService
    documents: DocumentService
    mcp_lab: McpLab
    casework: CaseworkService
    medassist: MedAssistService
    reviews: ReviewsService
    aftercare: AftercareService
    runs: RunRegistry

    @classmethod
    def build(cls, settings: Settings, client: Any, browser: Screenshotter | None = None,
              speech: SpeechTokens | None = None, gpt: StructuredModel | None = None,
              search: AzureSearch | None = None, foundry: AgentConversations | None = None,
              language: TextAnalyzer | None = None, agents: FrameworkAgents | None = None) -> "Container":
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
        if language is None and settings.azure_language_endpoint:
            language = AzureLanguage(settings.azure_language_endpoint)
        return cls(
            settings=settings,
            spend=spend,
            status=StatusService(claude, spend, gpt.models if gpt else []),
            messages=MessagesService(claude, spend),
            harness=HarnessService(claude, spend, registry, streamer, run_budget_usd=settings.run_budget_usd,
                                   approval_timeout_s=settings.approval_timeout_s),
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
            casework=CaseworkService(gpt, search or (AzureSearch(settings.azure_search_endpoint)
                                                     if settings.azure_search_endpoint else None), spend, settings.casework_dir),
            medassist=MedAssistService(foundry, spend, settings.medassist_db),
            reviews=ReviewsService(language, claude, spend),
            aftercare=AftercareService(claude, agents, spend, streamer, settings.aftercare_db),
            runs=registry,
        )
