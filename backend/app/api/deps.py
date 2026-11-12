"""Dependencies the routes ask for: the services, and the two guards every paid call passes."""
from __future__ import annotations

from urllib.parse import urlparse

from fastapi import Depends, Request

from ..container import Container
from ..core.errors import ApiError
from ..gateways.local_embeddings import LocalEmbedder
from ..services.aftercare import AftercareService
from ..services.aftercare_phone import AftercarePhone
from ..services.deals import DealsService
from ..services.diet import DietService
from ..services.hotel import HotelService
from ..services.brain import BrainCheckService
from ..services.scans import ScanService
from ..services.whiteboard import WhiteboardService
from ..services.token_counter import TokenCounterService
from ..services.medassist_phone import MedAssistPhone
from ..services.coding import CodingService
from ..services.data_model import VIEWERS, Viewer
from ..services.dataagent import DataAgentService
from ..services.decks import DeckService
from ..services.foundryops import FoundryOpsService
from ..services.guardrails import GuardrailsService
from ..services.translate import TranslateService
from ..services.searchlab import SearchLabService
from ..services.imagegen import ImageGenService
from ..services.understanding import UnderstandingService
from ..services.documents import DocumentService
from ..services.mcp_lab import McpLab
from ..services.medassist import MedAssistService
from ..services.casework import CaseworkService
from ..services.harness import HarnessService
from ..services.messages import MessagesService
from ..services.observability import ObservabilityService
from ..services.reviews import ReviewsService
from ..services.sites import SiteService
from ..services.tutor import TutorService
from ..services.storewatch import StoreWatchService
from ..services.workflows import WorkflowService
from ..services.skills import SkillsService
from ..services.spend import money
from ..services.status import StatusService


def container(request: Request) -> Container:
    return request.app.state.container


def status_service(c: Container = Depends(container)) -> StatusService:
    return c.status


def messages_service(c: Container = Depends(container)) -> MessagesService:
    return c.messages


def harness_service(c: Container = Depends(container)) -> HarnessService:
    return c.harness


def skills_service(c: Container = Depends(container)) -> SkillsService:
    return c.skills


def deck_service(c: Container = Depends(container)) -> DeckService:
    return c.decks


def site_service(c: Container = Depends(container)) -> SiteService:
    return c.sites


def tutor_service(c: Container = Depends(container)) -> TutorService:
    return c.tutor


def document_service(c: Container = Depends(container)) -> DocumentService:
    return c.documents


def mcp_lab(c: Container = Depends(container)) -> McpLab:
    return c.mcp_lab


def casework(c: Container = Depends(container)) -> CaseworkService:
    return c.casework


def medassist(c: Container = Depends(container)) -> MedAssistService:
    return c.medassist


def medassist_phone(c: Container = Depends(container)) -> MedAssistPhone:
    return c.medassist_phone


def reviews(c: Container = Depends(container)) -> ReviewsService:
    return c.reviews


def aftercare(c: Container = Depends(container)) -> AftercareService:
    return c.aftercare


def hotel(c: Container = Depends(container)) -> HotelService:
    return c.hotel


def diet(c: Container = Depends(container)) -> DietService:
    return c.diet


def deals(c: Container = Depends(container)) -> DealsService:
    return c.deals


def whiteboard(c: Container = Depends(container)) -> WhiteboardService:
    return c.whiteboard


def observability(c: Container = Depends(container)) -> ObservabilityService:
    return c.observability


def brain(c: Container = Depends(container)) -> BrainCheckService:
    return c.brain


def scans(c: Container = Depends(container)) -> ScanService:
    return c.scans


def token_counter(c: Container = Depends(container)) -> TokenCounterService:
    return c.token_counter


def local_embeddings(c: Container = Depends(container)) -> LocalEmbedder:
    return c.local_embeddings


def aftercare_phone(c: Container = Depends(container)) -> AftercarePhone:
    return c.aftercare_phone


def guardrails(c: Container = Depends(container)) -> GuardrailsService:
    return c.guardrails


def understanding(c: Container = Depends(container)) -> UnderstandingService:
    return c.understanding


def imagegen(c: Container = Depends(container)) -> ImageGenService:
    return c.imagegen


def searchlab(c: Container = Depends(container)) -> SearchLabService:
    return c.searchlab


def translate(c: Container = Depends(container)) -> TranslateService:
    return c.translate


def foundryops(c: Container = Depends(container)) -> FoundryOpsService:
    return c.foundryops


def dataagent(c: Container = Depends(container)) -> DataAgentService:
    return c.dataagent


def storewatch(c: Container = Depends(container)) -> StoreWatchService:
    return c.storewatch


def workflows(c: Container = Depends(container)) -> WorkflowService:
    return c.workflows


def coding(c: Container = Depends(container)) -> CodingService:
    return c.coding


def data_viewer(request: Request) -> Viewer:
    """Who is signed in to the data agent, and so which company's rows every query is limited to.

    The lab has no sign-in, so the page names a person in the x-lab-user header and this looks them up in a fixed
    directory. In a product this is where the verified session or token is read; the company comes from there,
    never from the request body or from the model.
    """
    viewer = VIEWERS.get(request.headers.get("x-lab-user", ""))
    if not viewer:
        raise ApiError(401, "not_signed_in", "Choose who is signed in: the data agent only answers for one company at a time.")
    return viewer


def require_lab_page(request: Request, c: Container = Depends(container)) -> None:
    """Only the lab's own pages may spend your credit.

    The Host check blocks DNS-rebinding tricks. The custom header forces a CORS preflight,
    which this server never approves, so other websites cannot make your browser call the API.
    """
    hosts = c.settings.allowed_hosts
    origin = request.headers.get("origin")
    if (request.headers.get("host") not in hosts
            or (origin and urlparse(origin).netloc not in hosts)
            or request.headers.get("x-llm-lab") != "1"):
        raise ApiError(403, "forbidden", "API calls are only accepted from the lab pages on this server.")


def require_budget(c: Container = Depends(container)) -> None:
    if c.spend.over_budget:
        raise ApiError(429, "budget_exceeded",
                       f"This session has spent about {money(c.spend.spent_usd)}, which reached the "
                       f"{money(c.spend.budget_usd)} budget. Restart the server with a higher --budget to continue.")
