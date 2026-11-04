"""The data agent with a scripted Claude: the semantic model, fields it makes, SQL it writes, the workbook and dashboards,
and row-level security between companies. No network."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from anthropic.types import Message
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.services import data_model as dm
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient

WEEKLY = {"topic": "pull_requests", "dimensions": ["pull_requests.merged_at:week"], "measures": ["pull_requests.count"],
          "filters": [{"field": "repositories.name", "op": "is", "values": ["harbour"]},
                      {"field": "pull_requests.base_ref", "op": "is", "values": ["main"]},
                      {"field": "pull_requests.state", "op": "is", "values": ["merged"]}],
          "sorts": [{"field": "pull_requests.merged_at:week", "desc": False}], "limit": 500}
MAYA = {**LAB, "x-lab-user": "maya"}  # Harbourside Labs
THEO = {**LAB, "x-lab-user": "theo"}  # Harbourside Labs too
ARIA = {**LAB, "x-lab-user": "aria"}  # Kestrel Freight


def reply(*blocks: dict) -> Message:
    return Message.model_validate({
        "id": "msg_test", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": list(blocks),
        "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 2000, "output_tokens": 150}})


def use(name: str, args: dict, n: int = 0) -> dict:
    return {"type": "tool_use", "id": f"toolu_{name}_{n}", "name": name, "input": args}


def text(t: str) -> dict:
    return {"type": "text", "text": t}


class Scripted(FakeClient):
    """Plays one reply per model call and keeps every request, so a test can read what the model was sent."""

    def __init__(self, replies: list[Message]) -> None:
        super().__init__()
        self.replies, self.requests = replies, []

        def create(**p: Any) -> Message:
            self.requests.append(json.loads(json.dumps(p, default=str)))
            return self.replies.pop(0)
        self.messages.create = create  # type: ignore[method-assign]
        self.beta.messages.create = create  # type: ignore[attr-defined]


def lab(tmp_path: Path, fake: FakeClient, budget: float = 2.0) -> TestClient:
    settings = Settings(port=8000, budget_usd=budget, frontend_dist=tmp_path, models_dir=tmp_path / "none",
                        sites_dir=tmp_path / "sites", casework_dir=tmp_path / "casework", generated_dir=tmp_path / "generated")
    return TestClient(create_app(settings, client=fake), base_url="http://localhost:8000")


def events(client: TestClient, body: dict, headers: dict = MAYA) -> list[dict]:
    r = client.post("/api/dataagent/ask", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def test_the_compiler_checks_names_and_keeps_values_out_of_the_sql() -> None:
    with pytest.raises(dm.QueryError, match="Did you mean repositories.name"):
        dm.compile_query({"topic": "pull_requests", "dimensions": ["repository.nam"], "measures": ["pull_requests.count"]}, 1)
    with pytest.raises(dm.QueryError):
        dm.compile_query({**WEEKLY, "dimensions": ["pull_requests.merged_at:fortnight"]}, 1)
    with pytest.raises(dm.QueryError):
        dm.compile_query({**WEEKLY, "filters": [{"field": "repositories.name", "op": "drop", "values": ["x"]}]}, 1)
    sql, params, columns = dm.compile_query({**WEEKLY, "filters": [
        {"field": "repositories.name", "op": "is", "values": ["harbour'; DROP TABLE pull_requests; --"]}]}, 1)
    assert "DROP" not in sql and "harbour'; DROP TABLE pull_requests; --" in params
    # The access filter comes first and its value is a parameter, not something the query spec can change.
    assert "WHERE pull_requests.company_id = ? AND" in sql and params[0] == 1
    assert columns == ["pull_requests.merged_at:week", "pull_requests.count"]


def test_the_warehouse_is_read_only_to_queries(tmp_path: Path) -> None:
    db = tmp_path / "w.db"
    dm.create_warehouse(db)
    mine = dm.tenant_path(db, 1)
    rows, *_ = dm.run_query(mine, WEEKLY, 1)
    assert len(rows) > 100 and all(r["pull_requests.count"] > 0 for r in rows)
    with pytest.raises(sqlite3.OperationalError):
        sqlite3.connect(f"file:{mine}?mode=ro", uri=True).execute("DELETE FROM pull_requests")
    found = dm.lookup_values(mine, "pull_requests", "repositories.name", 1, "harb")
    assert {"harbour", "harbour-api", "harbour-mobile"} <= {v["value"] for v in found["values"]}


def test_the_agent_looks_up_queries_charts_and_saves_a_tile(tmp_path: Path) -> None:
    fake = Scripted([
        reply(text("Let me check the repositories."), use("lookup_values", {"topic": "pull_requests", "field": "repositories.name", "search": "harbour"})),
        reply(use("run_query", {**WEEKLY, "purpose": "chart"})),
        reply(use("run_query", {**WEEKLY, "sorts": [{"field": "pull_requests.count", "desc": True}], "limit": 3, "purpose": "check"}, 1)),
        reply(use("set_visualization", {"kind": "line", "title": "Merged to main", "x": "pull_requests.merged_at:week",
                                        "y": ["pull_requests.count"], "series": None})),
        reply(use("add_to_dashboard", {"dashboard": "Engineering", "title": "Merged to main"})),
        reply(text("**Merged PRs** to main in harbour, by week.")),
    ])
    client = lab(tmp_path, fake)
    out = events(client, {"question": "PRs merged to main in harbour by week"})
    kinds = [e["type"] for e in out]
    assert kinds.count("query") == 1, "the check query must not replace the charted one"
    query = next(e for e in out if e["type"] == "query")
    assert query["query"]["limit"] == 500 and query["row_count"] > 100 and "?" in query["sql"]
    steps = [e for e in out if e["type"] == "step"]
    assert [s["label"] for s in steps] == ["Value lookup", "Query", "Query check", "Visualization", "Dashboard"]
    assert next(e for e in out if e["type"] == "viz")["viz"]["kind"] == "line"
    done = out[-1]
    assert done["type"] == "done" and done["cost_usd"] > 0
    session = next(e for e in out if e["type"] == "session")["session_id"]

    # The model saw a bounded result, and the system prompt and latest turn carry cache breakpoints.
    last = fake.requests[-1]
    result = json.loads(last["messages"][4]["content"][0]["content"])
    assert len(result["rows"]) <= 40 and result["truncated"] and "numeric_summary" in result
    assert last["system"][0]["cache_control"] and last["messages"][-1]["content"][-1]["cache_control"]
    assert sum("cache_control" in b for m in last["messages"] for b in m["content"]) == 1

    # The dashboard keeps the query, not the rows, and runs it again when opened.
    board = client.get("/api/dataagent/dashboards/Engineering", headers=MAYA).json()
    assert board["tiles"][0]["title"] == "Merged to main" and len(board["tiles"][0]["rows"]) == query["row_count"]

    # A follow-up in the same session carries the conversation on.
    fake.replies.append(reply(text("Same as before.")))
    events(client, {"question": "and the week with the most?", "session_id": session})
    assert len(fake.requests[-1]["messages"]) == 13


def test_the_agent_adds_a_field_to_the_model_and_charts_it(tmp_path: Path) -> None:
    share = {"topic": "pull_requests", "name": "pull_requests.large_share", "kind": "measure", "label": "Large PR share",
             "sql": "avg(case when pull_requests.additions + pull_requests.deletions > 500 then 1.0 else 0 end)",
             "description": "Share of PRs changing more than 500 lines"}
    fake = Scripted([
        reply(use("create_field", {**share, "sql": "avg(nosuch)"})),
        reply(use("create_field", share, 1)),
        reply(use("describe_topic", {"topic": "pull_requests"})),
        reply(use("run_query", {"topic": "pull_requests", "dimensions": ["authors.team"], "measures": ["pull_requests.large_share"]})),
        reply(use("set_visualization", {"kind": "bar", "title": "Large PRs by team", "x": "authors.team",
                                        "y": ["pull_requests.large_share"], "series": None})),
        reply(use("add_to_dashboard", {"dashboard": "Size", "title": "Large PRs by team"})),
        reply(text("Product opens the most large PRs (made a new field).")),
    ])
    client = lab(tmp_path, fake)
    out = events(client, {"question": "share of large PRs by team"})
    steps = [e for e in out if e["type"] == "step"]
    assert steps[0]["error"] and "no such column: nosuch" in steps[0]["detail"]
    assert [e["field"]["field"] for e in out if e["type"] == "field"] == ["pull_requests.large_share"]
    described = json.loads(fake.requests[3]["messages"][-1]["content"][0]["content"])
    assert any(m["field"] == "pull_requests.large_share" and m["made_in_this_workbook"] for m in described["measures"])
    query = next(e for e in out if e["type"] == "query")
    assert query["row_count"] == 4 and all(0 < r["pull_requests.large_share"] < 1 for r in query["rows"])
    # The tile carries the field's definition, so the dashboard runs it again on its own.
    tile = client.get("/api/dataagent/dashboards/Size", headers=MAYA).json()["tiles"][0]
    assert tile["query"]["custom_fields"][0]["name"] == "pull_requests.large_share" and len(tile["rows"]) == 4
    # And the field list can use it with no model call.
    picked = client.post("/api/dataagent/query", json=tile["query"] | {"dimensions": ["repositories.name"]}, headers=MAYA).json()
    assert len(picked["rows"]) == 4 and len(fake.requests) == 7


def test_the_agent_writes_sql_runs_it_read_only_and_charts_what_comes_back(tmp_path: Path) -> None:
    sql = ("SELECT u.team AS team, count(r.id) AS reviews, "
           "round(avg((julianday(r.submitted_at) - julianday(p.created_at)) * 24), 1) AS hours_to_review "
           "FROM reviews r JOIN users u ON u.id = r.reviewer_id JOIN pull_requests p ON p.id = r.pull_request_id "
           "GROUP BY u.team ORDER BY reviews DESC")
    fake = Scripted([
        reply(use("describe_schema", {})),
        reply(use("run_sql", {"sql": "DELETE FROM reviews"})),
        reply(use("run_sql", {"sql": "SELECT 1 AS a; DROP TABLE users"}, 1)),
        reply(use("run_sql", {"sql": "WITH x AS (SELECT 1) SELECT * FROM x, pragma_table_info('users')"}, 2)),
        reply(use("run_sql", {"sql": sql}, 3)),
        reply(use("set_visualization", {"kind": "bar", "title": "Reviews by team", "x": "team", "y": ["reviews"], "series": None})),
        reply(use("add_to_dashboard", {"dashboard": "Reviews", "title": "Reviews by team"})),
        reply(text("I wrote SQL: Product reviews the most.")),
    ])
    client = lab(tmp_path, fake)
    out = events(client, {"question": "which team reviews the most and how quickly?"})
    steps = [e for e in out if e["type"] == "step"]
    assert steps[0]["label"] == "Schema" and [s.get("error", False) for s in steps[1:5]] == [True, True, True, False]
    assert "Only SELECT" in steps[1]["detail"] and "One statement" in steps[2]["detail"] and "Not allowed" in steps[3]["detail"]
    schema = json.loads(fake.requests[1]["messages"][-1]["content"][0]["content"])
    assert {t["table"] for t in schema["tables"]} == {"repositories", "users", "pull_requests", "reviews", "issues"}
    query = next(e for e in out if e["type"] == "query")
    assert query["columns"] == ["team", "reviews", "hours_to_review"] and query["row_count"] == 4 and query["query"]["sql"]
    assert next(e for e in out if e["type"] == "viz")["viz"]["x"] == "team"
    tile = client.get("/api/dataagent/dashboards/Reviews", headers=MAYA).json()["tiles"][0]
    assert tile["rows"] == query["rows"]
    db = dm.tenant_path(tmp_path / "generated" / "data-agent" / "warehouse.db", 1)
    assert sqlite3.connect(db).execute("SELECT count(*) FROM reviews").fetchone()[0] > 20000


def test_sql_typed_in_the_sql_tab_is_free_and_checked(tmp_path: Path) -> None:
    client = lab(tmp_path, Scripted([]))
    ok = client.post("/api/dataagent/sql", json={"sql": "SELECT state, count(*) AS n FROM issues GROUP BY 1;", "limit": 2},
                     headers=MAYA).json()
    assert ok["columns"] == ["state", "n"] and ok["row_count"] == 2 and ok["truncated"] is False
    capped = client.post("/api/dataagent/sql", json={"sql": "SELECT id FROM issues", "limit": 3}, headers=MAYA).json()
    assert capped["row_count"] == 3 and capped["truncated"]
    for bad in ["UPDATE issues SET state = 'open'", "SELECT id, id FROM issues", "SELECT * FROM nowhere"]:
        r = client.post("/api/dataagent/sql", json={"sql": bad}, headers=MAYA)
        assert r.status_code == 400 and r.json()["error"]["type"] == "invalid_query"
    assert client.post("/api/dataagent/sql", json={"sql": "SELECT 1"}).status_code == 403
    assert client.post("/api/dataagent/sql", json={"sql": "SELECT 1"}, headers=LAB).status_code == 401


def test_errors_go_back_to_the_model_as_tool_results(tmp_path: Path) -> None:
    fake = Scripted([
        reply(use("run_query", {"topic": "pull_requests", "dimensions": ["repository.nam"], "measures": ["pull_requests.count"]})),
        reply(use("set_visualization", {"kind": "bar", "title": "x", "x": "nope", "y": [], "series": None})),
        reply(text("Sorry.")),
    ])
    out = events(lab(tmp_path, fake), {"question": "PRs by repo"})
    steps = [e for e in out if e["type"] == "step"]
    assert all(s["error"] for s in steps) and "Did you mean repositories.name" in steps[0]["detail"]
    sent = fake.requests[1]["messages"][-1]["content"][0]
    assert sent["is_error"] and "Did you mean" in sent["content"]


def test_the_field_picker_query_is_free_and_cached(tmp_path: Path) -> None:
    fake = Scripted([])
    client = lab(tmp_path, fake)
    model = client.get("/api/dataagent/model", headers=MAYA).json()
    assert {t["topic"] for t in model["topics"]} == {"pull_requests", "reviews", "issues"}
    first = client.post("/api/dataagent/query", json=WEEKLY, headers=MAYA).json()
    again = client.post("/api/dataagent/query", json=WEEKLY, headers=MAYA).json()
    assert not first["cached"] and again["cached"] and again["rows"] == first["rows"] and not fake.requests
    bad = client.post("/api/dataagent/query", json={**WEEKLY, "measures": ["pull_requests.nope"]}, headers=MAYA)
    assert bad.status_code == 400 and bad.json()["error"]["type"] == "invalid_query"


def test_asking_needs_the_lab_page_and_budget(tmp_path: Path) -> None:
    assert lab(tmp_path, Scripted([])).post("/api/dataagent/ask", json={"question": "hi"}).status_code == 403
    assert lab(tmp_path, Scripted([]), budget=0).post("/api/dataagent/ask", json={"question": "hi"}, headers=MAYA).status_code == 429
    assert lab(tmp_path, Scripted([])).post("/api/dataagent/ask", json={"question": "hi", "model": "gpt-4"}, headers=MAYA).status_code in (400, 422)


def test_each_company_sees_only_its_own_rows_whoever_writes_the_query(tmp_path: Path) -> None:
    client = lab(tmp_path, Scripted([]))
    shared = tmp_path / "generated" / "data-agent" / "warehouse.db"
    count = {"topic": "pull_requests", "measures": ["pull_requests.count"]}
    harbour = client.post("/api/dataagent/query", json=count, headers=MAYA).json()
    kestrel = client.post("/api/dataagent/query", json=count, headers=ARIA).json()
    totals = dict(sqlite3.connect(shared).execute("SELECT company_id, count(*) FROM pull_requests GROUP BY 1").fetchall())
    assert len(totals) == 3 and harbour["rows"][0]["pull_requests.count"] == totals[1]
    assert kestrel["rows"][0]["pull_requests.count"] == totals[2] and not kestrel["cached"], "the cache is per company"
    assert kestrel["company"] == "Kestrel Freight" and kestrel["params"] == [2]

    # The field list's values and the schema are the company's own.
    model = client.get("/api/dataagent/model", headers=ARIA).json()
    tables = {t["table"]: t for t in model["schema"]["tables"]}
    assert "companies" not in tables and tables["pull_requests"]["rows"] == totals[2]
    assert all(c["name"] != "company_id" for t in tables.values() for c in t["columns"])
    repos = next(c for c in tables["repositories"]["columns"] if c["name"] == "name")["values"]
    assert repos == ["driver-app", "kestrel-web", "routing"]

    # Hand-written SQL cannot reach another company: dropping the filter, asking for another id, or shadowing a table.
    def n(sql: str) -> int:
        r = client.post("/api/dataagent/sql", json={"sql": sql}, headers=ARIA)
        assert r.status_code == 200, r.text
        return r.json()["rows"][0]["n"]
    assert n("SELECT count(*) AS n FROM pull_requests") == totals[2]
    assert n("SELECT count(*) AS n FROM pull_requests WHERE company_id = 1") == 0
    assert n("SELECT count(DISTINCT company_id) AS n FROM pull_requests") == 1
    assert n("WITH pull_requests AS (SELECT * FROM main.pull_requests) SELECT count(*) AS n FROM pull_requests") == totals[2]
    assert n("SELECT count(*) AS n FROM companies") == 1
    for bad in ["SELECT * FROM shared.pull_requests", "ATTACH DATABASE 'warehouse.db' AS w",
                "SELECT * FROM pragma_database_list"]:
        assert client.post("/api/dataagent/sql", json={"sql": bad}, headers=ARIA).status_code == 400

    # No sign-in, or someone not in the directory, gets nothing.
    assert client.post("/api/dataagent/query", json=count, headers=LAB).status_code == 401
    assert client.get("/api/dataagent/model", headers={**LAB, "x-lab-user": "mallory"}).status_code == 401
    assert {v["company"] for v in client.get("/api/dataagent/viewers", headers=LAB).json()["viewers"]} == {
        "Harbourside Labs", "Kestrel Freight", "Larkspur Health"}


def test_workbooks_and_dashboards_belong_to_the_company(tmp_path: Path) -> None:
    fake = Scripted([
        reply(use("run_query", {"topic": "pull_requests", "dimensions": ["repositories.name"], "measures": ["pull_requests.count"]})),
        reply(use("set_visualization", {"kind": "bar", "title": "PRs by repo", "x": "repositories.name",
                                        "y": ["pull_requests.count"], "series": None})),
        reply(use("add_to_dashboard", {"dashboard": "Engineering", "title": "PRs by repo"})),
        reply(text("Done.")),
    ])
    client = lab(tmp_path, fake)
    out = events(client, {"question": "PRs by repo, on a dashboard"})
    assert "sees Harbourside Labs's rows only" in fake.requests[0]["system"][0]["text"]
    session = next(e for e in out if e["type"] == "session")["session_id"]

    # A colleague at the same company sees the dashboard; another company does not, even by name.
    assert client.get("/api/dataagent/model", headers=THEO).json()["dashboards"].keys() == {"Engineering"}
    assert client.get("/api/dataagent/model", headers=ARIA).json()["dashboards"] == {}
    assert client.get("/api/dataagent/dashboards/Engineering", headers=ARIA).status_code == 404
    assert client.delete("/api/dataagent/dashboards/Engineering", headers=ARIA).status_code == 200
    assert client.get("/api/dataagent/dashboards/Engineering", headers=MAYA).status_code == 200

    # Maya's session id, sent as Aria, starts a new workbook: the old one's messages hold Harbourside's rows.
    fake.replies.append(reply(text("A fresh workbook.")))
    again = events(client, {"question": "and now?", "session_id": session}, headers=ARIA)
    assert next(e for e in again if e["type"] == "session")["session_id"] != session
    assert len(fake.requests[-1]["messages"]) == 1 and "Kestrel Freight" in fake.requests[-1]["system"][0]["text"]
