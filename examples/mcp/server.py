"""An MCP server for a consulting team's engagements: search them, read one, log a risk.

Small on purpose, so each design choice is easy to see:

- Few tools, each a whole task. `search_engagements` and `get_engagement` read; `log_risk` writes.
  Claude picks tools by their names and descriptions, so those are written for the model.
- Structured results (pydantic models), small by default and paged with a cursor, so a
  search never floods the model's context.
- Errors the model can act on: a ToolError says what went wrong and what to do next.
- Annotations say which tools only read and which change data, so a client can ask a person
  before a write. The write takes an idempotency key, so a retried call cannot log a risk twice.
- One server, two transports. stdio for Claude Code on your machine (the local user is trusted).
  Streamable HTTP for a hosted server: stateless, so it scales behind a load balancer, and every
  request needs a bearer token whose scopes decide what it may do.

    python server.py                       # stdio, for Claude Code or ask_claude.py
    MCP_TOKENS="dev-read=engagements:read;dev-write=engagements:read engagements:write" \\
        python server.py --http --port 8765    # Streamable HTTP at http://127.0.0.1:8765/mcp
"""
from __future__ import annotations

import argparse
import base64
import os
from typing import Literal

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ResourceNotFoundError, ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

from engagements_data import Engagement, Risk, Severity, Store, sample_store  # noqa: F401

Status = Literal["active", "closed", "all"]

READ, WRITE = "engagements:read", "engagements:write"

INSTRUCTIONS = """Engagement tracker for the delivery team. Find an engagement with search_engagements,
read it with get_engagement, and record a new risk with log_risk. Ids look like ENG-104 and RISK-7."""


# --- Results the tools return ---------------------------------------------------------------

class EngagementSummary(BaseModel):
    id: str
    client: str
    name: str
    status: str
    open_risks: int


class SearchResult(BaseModel):
    engagements: list[EngagementSummary]
    total: int = Field(description="How many engagements match, across all pages")
    next_cursor: str | None = Field(description="Pass to search_engagements to get the next page; null on the last page")


class EngagementDetail(BaseModel):
    engagement: Engagement
    budget_used_percent: float


class LoggedRisk(BaseModel):
    risk: Risk
    engagement_id: str
    created: bool = Field(description="False when this idempotency key had already logged the risk")


# --- The server -----------------------------------------------------------------------------

def require(scope: str) -> None:
    """Over HTTP, the caller's token must carry the scope. Over stdio there is no token: the server
    runs as the local user, who is already trusted with whatever the process can reach."""
    token = get_access_token()
    if token is not None and scope not in token.scopes:
        raise ToolError(f"Your access token does not have the {scope} scope, so this call was refused. "
                        "Ask an administrator for that scope; do not retry.")


def build_server(store: Store | None = None, auth: AuthSettings | None = None, token_verifier=None) -> MCPServer:
    store = store or sample_store()
    mcp = MCPServer("engagements", instructions=INSTRUCTIONS, version="1.0.0", auth=auth, token_verifier=token_verifier)

    def find(engagement_id: str) -> Engagement:
        e = store.engagements.get(engagement_id.strip().upper())
        if e is None:
            raise ToolError(f"No engagement with id {engagement_id!r}. Ids look like ENG-104; "
                            "use search_engagements to find the right one.")
        return e

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
    def search_engagements(query: str = "", status: Status = "active", limit: int = Field(5, ge=1, le=20),
                           cursor: str | None = None) -> SearchResult:
        """Find engagements by client, name, partner or summary. Returns short summaries; call
        get_engagement for the full record. Results are paged: pass next_cursor to get more.

        Args:
            query: Words to match, such as a client or partner name. Empty matches every engagement.
            status: active (default), closed, or all.
            limit: How many to return, 1 to 20.
            cursor: next_cursor from a previous call, to continue that search.
        """
        require(READ)
        words = query.lower().split()
        matches = [e for e in store.engagements.values()
                   if (status == "all" or e.status == status)
                   and all(w in f"{e.client} {e.name} {e.partner} {e.summary}".lower() for w in words)]
        start = decode_cursor(cursor)
        page = matches[start:start + limit]
        more = start + limit < len(matches)
        return SearchResult(
            engagements=[EngagementSummary(id=e.id, client=e.client, name=e.name, status=e.status,
                                           open_risks=len(e.risks)) for e in page],
            total=len(matches), next_cursor=encode_cursor(start + limit) if more else None)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
    def get_engagement(engagement_id: str) -> EngagementDetail:
        """The full record of one engagement: dates, partner, budget and spend, and its open risks.

        Args:
            engagement_id: The engagement's id, such as ENG-104.
        """
        require(READ)
        e = find(engagement_id)
        return EngagementDetail(engagement=e, budget_used_percent=round(100 * e.spent_gbp / e.budget_gbp, 1))

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True,
                                          open_world_hint=False))
    def log_risk(engagement_id: str, title: str = Field(min_length=5, max_length=200), severity: Severity = "medium",
                 owner: str = Field(min_length=2, max_length=80),
                 idempotency_key: str = Field(min_length=8, max_length=64)) -> LoggedRisk:
        """Record a new risk on an active engagement. Use only when the user asks to log or raise a risk.

        Args:
            engagement_id: The engagement's id, such as ENG-104.
            title: One sentence saying what could go wrong and why it matters.
            severity: low, medium or high.
            owner: The person who will manage the risk.
            idempotency_key: Any unique string for this request, such as a UUID. Sending the same key
                again returns the risk already logged instead of adding a second one.
        """
        require(WRITE)
        e = find(engagement_id)
        if e.status != "active":
            raise ToolError(f"{e.id} is closed, so risks can no longer be logged on it.")
        risk, created = store.add_risk(e.id, title.strip(), severity, owner.strip(), idempotency_key)
        return LoggedRisk(risk=risk, engagement_id=e.id, created=created)

    # A resource is data the client (or the person) chooses to attach, rather than a call the model makes.
    @mcp.resource("engagement://{engagement_id}/brief", mime_type="text/markdown")
    def engagement_brief(engagement_id: str) -> str:
        """A one-page brief of an engagement, for attaching to a conversation."""
        e = store.engagements.get(engagement_id.upper())
        if e is None:
            raise ResourceNotFoundError(f"No engagement {engagement_id}")
        risks = "\n".join(f"- {r.id} ({r.severity}): {r.title}, owner {r.owner}" for r in e.risks) or "- None open"
        return (f"# {e.client}: {e.name}\n\n{e.summary}\n\nPartner: {e.partner}. {e.start} to {e.end}.\n"
                f"Budget £{e.budget_gbp:,}, spent £{e.spent_gbp:,}.\n\n## Open risks\n{risks}\n")

    # A catalogue: one resource that lists everything there is, so an agent can see what exists (ids and a line
    # each) without exploratory search calls, then go straight to get_engagement.
    @mcp.resource("engagement://catalogue", mime_type="text/markdown")
    def engagement_catalogue() -> str:
        """Every engagement, active and closed, with its id and a one-line summary."""
        rows = "\n".join(f"- {e.id} ({e.status}): {e.client}, {e.name}. {e.summary.split('. ')[0].rstrip('.')}."
                         for e in store.engagements.values())
        return f"# Engagements ({len(store.engagements)})\n\nRead one with get_engagement.\n\n{rows}\n"

    # A prompt is a reusable starting message the person picks, such as a slash command in Claude Code.
    @mcp.prompt()
    def weekly_update(engagement_id: str) -> str:
        """Draft this week's client update for an engagement."""
        return (f"Use get_engagement to read {engagement_id}, then draft a short weekly update for the client: "
                "progress, budget used, the open risks with their owners, and next week's focus.")

    return mcp


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode()


def decode_cursor(cursor: str | None) -> int:
    """Cursors are opaque to the client, so the paging scheme can change without breaking anyone."""
    if not cursor:
        return 0
    try:
        kind, value = base64.urlsafe_b64decode(cursor.encode()).decode().split(":", 1)
        assert kind == "o"
        return max(0, int(value))
    except Exception as exc:
        raise ToolError("That cursor is not valid. Start the search again without a cursor.") from exc


# --- Auth for the HTTP transport ---------------------------------------------------------------

class StaticTokens:
    """Bearer tokens from the MCP_TOKENS environment variable: "token=scope scope;token=scope".

    Enough for development. In production, verify a JWT from your identity provider instead
    (Amazon Cognito, Entra ID, Okta): check its signature against the provider's JWKS, its expiry,
    and that its audience is this server's URL, then read its scopes. Only verify_token changes.
    """

    def __init__(self, spec: str, resource: str):
        self.resource = resource  # the audience: these tokens are for this server only
        self.tokens: dict[str, list[str]] = {}
        for part in filter(None, (p.strip() for p in spec.split(";"))):
            token, _, scopes = part.partition("=")
            self.tokens[token.strip()] = scopes.split()

    async def verify_token(self, token: str) -> AccessToken | None:
        scopes = self.tokens.get(token)
        if scopes is None:
            return None
        return AccessToken(token=token, client_id="dev", scopes=scopes, resource=self.resource)


def http_app(public_url: str, issuer_url: str, tokens: str, allowed_hosts: list[str]):
    """The Streamable HTTP app: stateless JSON responses, every request authenticated."""
    # validate_token_resource: refuse a token issued for any other server (RFC 8707 audience), so a
    # token meant for one MCP server cannot be replayed against this one.
    auth = AuthSettings(issuer_url=issuer_url, resource_server_url=public_url, required_scopes=[READ],
                        validate_token_resource=True)
    server = build_server(auth=auth, token_verifier=StaticTokens(tokens, public_url))
    return server.streamable_http_app(
        stateless_http=True, json_response=True,
        transport_security=TransportSecuritySettings(allowed_hosts=allowed_hosts))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--http", action="store_true", help="serve Streamable HTTP instead of stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--public-url", default=os.environ.get("MCP_PUBLIC_URL", ""),
                        help="the address clients use, such as https://mcp.example.com/mcp")
    args = parser.parse_args()
    if not args.http:
        build_server().run("stdio")
        return
    tokens = os.environ.get("MCP_TOKENS", "")
    if not tokens:
        raise SystemExit("Set MCP_TOKENS, for example MCP_TOKENS='dev-read=engagements:read'. "
                         "A hosted server never runs without authentication.")
    import uvicorn

    public_url = args.public_url or f"http://{args.host}:{args.port}/mcp"
    hosts = [f"{args.host}:{args.port}", "localhost:*", "127.0.0.1:*"]
    if args.public_url:
        hosts.append(args.public_url.split("/")[2])
    app = http_app(public_url, os.environ.get("MCP_ISSUER_URL", "https://auth.example.com"), tokens, hosts)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
