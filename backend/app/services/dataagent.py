"""The data agent: Claude answers questions about a warehouse in a workbook, through a semantic model or in SQL.

Claude works three ways, best first. It queries the semantic model by field name, and `data_model.compile_query`
checks the names and builds the SQL, so agreed definitions (merge rate, hours to merge) are used everywhere. When a
field is missing it creates one, an expression over the topic's tables, which is tried once and then stays in the
workbook's model. When the model cannot express the question (two topics at once, ranks, subqueries) it reads the
schema and writes SQL itself. Every query, whoever wrote it, runs on a connection that can only read, with an
authorizer and a time limit. The rows that come back drive the chart and the dashboard tiles.

Each step is streamed to the page as it happens, results are cached by their SQL, and the workbook (the current
query, its rows, its chart and any fields made in it) lives in the session, so "now by team" edits it.

Everything belongs to the signed-in person's company: queries run on that company's copy of the warehouse, the cache
is keyed by company, and workbooks and dashboards are kept per company. The company comes from the sign-in (the
`Viewer`), never from the model's tool input, so no prompt or tool call can widen it.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from ..core.errors import ApiError, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, cost_usd
from . import data_model as dm
from .runs import Run, RunStreamer
from .spend import SpendTracker

MAX_ROUNDS = 16
MAX_SESSIONS = 20
ROWS_TO_MODEL = 40

FILTER_SCHEMA = {"type": "object", "properties": {
    "field": {"type": "string", "description": "a dimension, optionally with :timeframe"},
    "op": {"type": "string", "enum": sorted(dm.OPS)},
    "values": {"type": "array", "items": {}, "description": "values for is/is_not (any of), one for gt/lt/contains, two for between"}},
    "required": ["field", "op"]}
QUERY_PROPS = {
    "topic": {"type": "string"},
    "dimensions": {"type": "array", "items": {"type": "string"}, "description": "fields to group by; timestamps as field:week etc."},
    "measures": {"type": "array", "items": {"type": "string"}},
    "filters": {"type": "array", "items": FILTER_SCHEMA},
    "sorts": {"type": "array", "items": {"type": "object", "properties": {"field": {"type": "string"}, "desc": {"type": "boolean"}},
                                         "required": ["field"]}},
    "limit": {"type": "integer", "description": f"rows, at most {dm.MAX_ROWS}; default 500"},
    "purpose": {"type": "string", "enum": ["chart", "check"], "description": "chart (default) makes it the workbook's query; "
                "check only answers your own question, such as the top weeks, and leaves the workbook as it is"},
}
TOOLS = [
    {"name": "search_model", "description": "Find the topics and fields that match what the user asked about. Start here.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "describe_topic", "description": "Every dimension and measure of one topic, with descriptions and the timeframes.",
     "input_schema": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"]}},
    {"name": "lookup_values", "description": "The most common values of a dimension, to filter on a value that exists "
                                             "(e.g. the exact repository name). Use before filtering on text.",
     "input_schema": {"type": "object", "properties": {"topic": {"type": "string"}, "field": {"type": "string"},
                                                       "search": {"type": "string"}}, "required": ["topic", "field"]}},
    {"name": "run_query", "description": "Run a query on one topic and make it the workbook's current query. Returns the "
                                         "first rows, the row count and the SQL the model compiled.",
     "input_schema": {"type": "object", "properties": QUERY_PROPS, "required": ["topic"]}},
    {"name": "create_field", "description": "Add a dimension or measure to a topic for this workbook, defined as one SQL "
                                            "expression over the topic's tables (aliases as in describe_topic's fields, e.g. "
                                            "pull_requests.additions, authors.team). Measures aggregate (sum, avg, count). "
                                            "It is tried once; then use it by name in run_query.",
     "input_schema": {"type": "object", "properties": {
         "topic": {"type": "string"}, "name": {"type": "string", "description": "topic.snake_case, e.g. pull_requests.large_share"},
         "label": {"type": "string"}, "kind": {"type": "string", "enum": sorted(dm.KINDS)},
         "sql": {"type": "string", "description": "one expression, no SELECT"}, "description": {"type": "string"},
         "joins": {"type": "array", "items": {"type": "string"}, "description": "joins the expression needs, e.g. authors"}},
         "required": ["topic", "name", "kind", "sql", "description"]}},
    {"name": "describe_schema", "description": "The warehouse's tables, columns, row counts, joins and the values of short "
                                               "text columns. Read it before writing SQL.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "run_sql", "description": "Run one SQLite SELECT you wrote, for questions the semantic model cannot express. "
                                       "Alias every column. Like run_query, it becomes the workbook's query unless purpose is check.",
     "input_schema": {"type": "object", "properties": {
         "sql": {"type": "string"}, "limit": {"type": "integer", "description": f"rows, at most {dm.MAX_ROWS}; default 500"},
         "purpose": QUERY_PROPS["purpose"]}, "required": ["sql"]}},
    {"name": "set_visualization", "description": "Chart the current query. x is a column; y are measure columns; series "
                                                 "(optional) splits lines or bars by a second dimension.",
     "input_schema": {"type": "object", "properties": {
         "kind": {"type": "string", "enum": ["line", "bar", "area", "table", "number"]}, "title": {"type": "string"},
         "x": {"type": "string"}, "y": {"type": "array", "items": {"type": "string"}}, "series": {"type": "string"}},
         "required": ["kind", "title"]}},
    {"name": "add_to_dashboard", "description": "Add the current query and its chart to a dashboard as a tile.",
     "input_schema": {"type": "object", "properties": {"dashboard": {"type": "string", "description": "the dashboard's name"},
                                                       "title": {"type": "string"}}, "required": ["dashboard", "title"]}},
]
TOOLS[-1] = {**TOOLS[-1], "cache_control": {"type": "ephemeral"}}

SYSTEM = """You are the workbook agent for {company}'s engineering data, working for {name}. You answer from
queries you run, never from memory. Every query sees {company}'s rows only; no other company's data is reachable, so
if asked about other companies, say so.

Three ways to query, in this order of preference:
A. The semantic model. search_model with the user's words, then describe_topic. Use field names exactly as given.
   Before filtering on a text value (a repository, a team, a branch), lookup_values to find the exact value. Then
   run_query. Group timestamps with a timeframe (field:week, :month) and filter out empty ones (op not_null).
B. A new field. If the topic lacks a dimension or measure you need but it can be written as an expression over the
   topic's tables, create_field and use it in run_query. Prefer this to SQL: the field stays in the model.
C. Your own SQL. If the question needs what the model cannot express (two topics joined, a rank or running total,
   a subquery), describe_schema and run_sql with one SQLite SELECT. Alias every column in snake_case.
Tell the user in one phrase which way you used.

For run_query and run_sql: purpose chart (the default) makes the result the workbook's query and chart; purpose
check only answers your own question (the top weeks, a total) and leaves the chart alone. If a tool returns an
error, read it and fix the query.

Then set_visualization for the charted result, using its column names: line or area over time, bar for categories,
number for a single value, table for lists. Answer in a few short sentences with two or three highlights from the
numbers. Say what you filtered on. Do not invent numbers that are not in the results.

For a dashboard, build four to six tiles that together answer the request, each with a chart query,
set_visualization and add_to_dashboard, then summarise what each tile shows.

Today is {today}. Companies, repositories, teams and people are invented. Keep each message to the user brief."""


@dataclass
class Workbook:
    id: str
    model: str
    viewer: dm.Viewer
    messages: list[dict] = field(default_factory=list)
    query: dict | None = None
    rows: list[dict] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    custom: dict[str, list[dict]] = field(default_factory=dict)  # fields made in this workbook, by topic
    sql: str = ""
    viz: dict | None = None
    cost_usd: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


class DataAgentService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer, folder: Path):
        self.claude, self.spend, self.streamer, self.folder = claude, spend, streamer, folder
        self.warehouse = folder / "warehouse.db"  # every company; queries never run on it
        self.dash_file = folder / "dashboards.json"
        self.sessions: OrderedDict[str, Workbook] = OrderedDict()
        self.cache: dict[str, tuple[list[dict], list[str], bool]] = {}
        self._lock = threading.Lock()

    def _db(self, viewer: dm.Viewer) -> Path:
        """The signed-in company's copy of the warehouse: the only file a query of theirs can open."""
        with self._lock:
            if not all(dm.tenant_path(self.warehouse, c["id"]).exists() for c in dm.COMPANIES):
                dm.create_warehouse(self.warehouse)
        return dm.tenant_path(self.warehouse, viewer.company_id)

    @staticmethod
    def viewers() -> list[dict[str, Any]]:
        return [{"id": v.id, "name": v.name, "company": v.company} for v in dm.VIEWERS.values()]

    # ----- the model, for the field picker -----
    def model(self, viewer: dm.Viewer) -> dict[str, Any]:
        return {"topics": [dm.describe_topic(t) for t in dm.TOPICS], "timeframes": list(dm.TIMEFRAMES), "max_rows": dm.MAX_ROWS,
                "schema": dm.describe_schema(self._db(viewer)), "dashboards": self.dashboards(viewer),
                "viewer": {"id": viewer.id, "name": viewer.name, "company": viewer.company}}

    def query(self, q: dict[str, Any], viewer: dm.Viewer) -> dict[str, Any]:
        """A query from the field picker, or SQL typed in the SQL tab: no model involved, the same checks and cache."""
        try:
            return self._run(q, viewer)
        except dm.QueryError as exc:
            raise ApiError(400, "invalid_query", str(exc)) from exc

    def _run(self, q: dict[str, Any], viewer: dm.Viewer) -> dict[str, Any]:
        """Either kind of query: a semantic one ({topic, dimensions, ...}) or SQL ({sql, limit}), on the viewer's
        company's copy. Cached by company and SQL, so one company's rows are never served to another."""
        path = self._db(viewer)
        cid = viewer.company_id
        started = time.perf_counter()
        if "sql" in q:
            sql, params, limit = dm.check_sql(q["sql"]), [], max(1, min(int(q.get("limit") or 500), dm.MAX_ROWS))
            q = {"sql": sql, "limit": limit}
        else:
            sql, params, _ = dm.compile_query(q, cid)
        key = json.dumps([cid, sql, params])
        cached = key in self.cache
        if cached:
            rows, columns, truncated = self.cache[key]
        elif "sql" in q:
            rows, sql, columns, truncated = dm.run_sql(path, sql, q["limit"])
            self.cache[key] = (rows, columns, truncated)
        else:
            rows, sql, params, columns = dm.run_query(path, q, cid)
            truncated = False
            self.cache[key] = (rows, columns, truncated)
        return {"query": q, "rows": rows, "columns": columns, "sql": sql, "params": params, "cached": cached,
                "ms": round((time.perf_counter() - started) * 1000, 1), "row_count": len(rows), "truncated": truncated,
                "company": viewer.company}

    # ----- dashboards, kept per company -----
    def _all_dashboards(self) -> dict[str, dict[str, list[dict]]]:
        d = json.loads(self.dash_file.read_text()) if self.dash_file.exists() else {}
        if d and all(isinstance(v, list) for v in d.values()):  # saved before companies: they were Harbourside's
            d = {"1": d}
        return d

    def dashboards(self, viewer: dm.Viewer) -> dict[str, list[dict]]:
        return self._all_dashboards().get(str(viewer.company_id), {})

    def _save_tile(self, viewer: dm.Viewer, dashboard: str, tile: dict) -> int:
        with self._lock:
            d = self._all_dashboards()
            tiles = d.setdefault(str(viewer.company_id), {}).setdefault(dashboard, [])
            tiles.append(tile)
            self.folder.mkdir(parents=True, exist_ok=True)
            self.dash_file.write_text(json.dumps(d))
            return len(tiles)

    def delete_dashboard(self, name: str, viewer: dm.Viewer) -> dict[str, Any]:
        with self._lock:
            d = self._all_dashboards()
            d.get(str(viewer.company_id), {}).pop(name, None)
            self.dash_file.write_text(json.dumps(d))
        return self.dashboards(viewer)

    def tile_data(self, dashboard: str, viewer: dm.Viewer) -> list[dict]:
        """Each tile's query run again (from the cache when nothing changed), so dashboards show current data."""
        tiles = self.dashboards(viewer).get(dashboard)
        if tiles is None:
            raise ApiError(404, "not_found", f"No dashboard called {dashboard}.")
        out = []
        for t in tiles:
            try:
                r = self._run(t["query"], viewer)
                out.append({**t, "rows": r["rows"], "columns": r["columns"], "sql": r["sql"]})
            except dm.QueryError as exc:
                out.append({**t, "error": str(exc), "rows": [], "columns": []})
        return out

    # ----- the agent -----
    def _session(self, session_id: str | None, model: str, viewer: dm.Viewer) -> Workbook:
        """The viewer's workbook. Someone else's session id starts a new one: its messages hold the other's rows."""
        with self._lock:
            wb = self.sessions.get(session_id or "")
            if wb and wb.viewer == viewer:
                wb.model = model
                return wb
            wb = Workbook(uuid.uuid4().hex, model, viewer)
            self.sessions[wb.id] = wb
            while len(self.sessions) > MAX_SESSIONS:
                self.sessions.popitem(last=False)
            return wb

    def _tool(self, wb: Workbook, name: str, args: dict, run: Run) -> tuple[dict, dict]:
        """Runs one tool. Returns what the model reads, and a step for the page."""
        try:
            if name == "search_model":
                r = dm.search_model(args.get("query", ""))
                return r, {"label": "Search model", "detail": "Looked up " + ", ".join(t["label"] for t in r["topics"][:2])}
            if name == "describe_topic":
                r = dm.describe_topic(args.get("topic", ""))
                for c in wb.custom.get(r["topic"], []):
                    entry = {"field": c["name"], "label": c.get("label") or c["name"], "description": c.get("description", ""),
                             "made_in_this_workbook": True}
                    (r["measures"] if c["kind"] == "measure" else r["dimensions"]).append(
                        entry if c["kind"] == "measure" else {**entry, "type": c["kind"]})
                return r, {"label": "Describe topic", "detail": f"{r['label']}: {len(r['dimensions'])} dimensions, {len(r['measures'])} measures"}
            if name == "lookup_values":
                r = dm.lookup_values(self._db(wb.viewer), args.get("topic", ""), args.get("field", ""), wb.viewer.company_id,
                                     args.get("search", ""), custom=wb.custom.get(args.get("topic", "")))
                return r, {"label": "Value lookup", "detail": f"{args.get('field')} · {r['count']} values"}
            if name == "create_field":
                topic = args.get("topic", "")
                spec = {k: args[k] for k in ("name", "label", "kind", "sql", "description", "joins") if args.get(k) is not None}
                f = dm.define_field(topic, spec)
                custom = [c for c in wb.custom.get(topic, []) if c["name"] != f.name] + [spec]
                probe = {"topic": topic, "custom_fields": custom, "limit": 3,
                         ("measures" if f.kind == "measure" else "dimensions"): [f.name]}
                sample = self._run(probe, wb.viewer)["rows"]  # a bad column or function fails here, not in a chart later
                wb.custom[topic] = custom
                run.publish({"type": "field", "topic": topic, "field": {
                    "field": f.name, "label": f.label, "description": f.description, "measure": f.kind == "measure",
                    "type": None if f.kind == "measure" else f.kind, "sql": f.sql}})
                return {"ok": True, "field": f.name, "sample": sample}, \
                    {"label": "Create field", "detail": f"{f.name} ({f.kind})", "sql": f.sql}
            if name == "describe_schema":
                r = dm.describe_schema(self._db(wb.viewer))
                return r, {"label": "Schema", "detail": f"{len(r['tables'])} tables"}
            if name in ("run_query", "run_sql"):
                check = args.pop("purpose", "chart") == "check"
                if name == "run_sql":
                    q = {"sql": args.get("sql", ""), "limit": args.get("limit") or 500}
                else:
                    custom = wb.custom.get(args.get("topic", ""))
                    q = {**args, "custom_fields": custom} if custom else args
                r = self._run(q, wb.viewer)
                if not check:
                    wb.query, wb.rows, wb.columns, wb.sql, wb.viz = r["query"], r["rows"], r["columns"], r["sql"], None
                    run.publish({"type": "query", **r})
                summary = {"row_count": r["row_count"], "columns": r["columns"], "rows": r["rows"][:ROWS_TO_MODEL],
                           "truncated": r["row_count"] > ROWS_TO_MODEL or r["truncated"], "sql": r["sql"]}
                if r["row_count"] > ROWS_TO_MODEL:  # the model sees the shape of the rest, not every row
                    for c in r["columns"]:
                        vals = [x[c] for x in r["rows"] if isinstance(x[c], (int, float))]
                        if vals:
                            summary.setdefault("numeric_summary", {})[c] = {"min": min(vals), "max": max(vals), "mean": round(sum(vals) / len(vals), 2)}
                what = "SQL" if name == "run_sql" else "Query"
                return summary, {"label": f"{what} check" if check else what,
                                 "detail": f"{r['row_count']} rows{', from cache' if r['cached'] else ''}", "sql": r["sql"]}
            if name == "set_visualization":
                if not wb.query:
                    raise dm.QueryError("Run a query first.")
                for col in [args.get("x"), *(args.get("y") or []), args.get("series")]:
                    if col and col not in wb.columns:
                        raise dm.QueryError(f"{col} is not a column of the current query: {', '.join(wb.columns)}")
                wb.viz = {k: args.get(k) for k in ("kind", "title", "x", "y", "series")}
                run.publish({"type": "viz", "viz": wb.viz})
                return {"ok": True}, {"label": "Visualization", "detail": f"{args.get('kind')}: {args.get('title')}"}
            if name == "add_to_dashboard":
                if not wb.query or not wb.viz:
                    raise dm.QueryError("Run a query and set its visualization first.")
                tile = {"id": uuid.uuid4().hex[:8], "title": args.get("title") or wb.viz.get("title"), "query": wb.query, "viz": wb.viz}
                count = self._save_tile(wb.viewer, args.get("dashboard") or "Dashboard", tile)
                run.publish({"type": "tile", "dashboard": args.get("dashboard") or "Dashboard", "tile": tile})
                return {"ok": True, "tiles": count}, \
                    {"label": "Dashboard", "detail": f"Added '{tile['title']}' to {args.get('dashboard')}"}
            raise dm.QueryError(f"No tool called {name}.")
        except dm.QueryError as exc:
            return {"error": str(exc)}, {"label": name.replace("_", " ").capitalize(), "detail": str(exc), "error": True}

    def ask(self, question: str, session_id: str | None, model: str | None, viewer: dm.Viewer) -> Iterator[str]:
        wb = self._session(session_id, model or DEFAULT_MODEL, viewer)
        if not wb.lock.acquire(blocking=False):
            raise ApiError(409, "busy", "The agent is still answering the last question.")
        run = Run()

        def work() -> None:
            try:
                run.publish({"type": "session", "session_id": wb.id})
                wb.messages.append({"role": "user", "content": [{"type": "text", "text": question}]})
                system = [{"type": "text", "text": SYSTEM.format(today=date.today().isoformat(), company=wb.viewer.company, name=wb.viewer.name), "cache_control": {"type": "ephemeral"}}]
                spent = 0.0
                for _ in range(MAX_ROUNDS):
                    if run.cancelled.is_set():
                        return
                    for m in wb.messages:
                        for b in m["content"]:
                            if isinstance(b, dict):
                                b.pop("cache_control", None)
                    wb.messages[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}
                    try:
                        r = self.claude.create(model=wb.model, max_tokens=1500, system=system, tools=TOOLS, messages=wb.messages)
                    except Exception as exc:
                        raise to_api_error(exc) from exc
                    spent += self.spend.charge(r, wb.model) or 0.0
                    wb.messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in r.content]})
                    for b in r.content:
                        if b.type == "text" and b.text.strip():
                            run.publish({"type": "text", "text": b.text})
                    uses = [b for b in r.content if b.type == "tool_use"]
                    if not uses:
                        break
                    results = []
                    for b in uses:
                        out, step = self._tool(wb, b.name, dict(b.input), run)
                        run.publish({"type": "step", "tool": b.name, "input": dict(b.input), **step})
                        results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out, default=str),
                                        **({"is_error": True} if "error" in out else {})})
                    wb.messages.append({"role": "user", "content": results})
                wb.cost_usd += spent
                run.publish({"type": "done", "cost_usd": round(spent, 6), "total_usd": round(wb.cost_usd, 6),
                             "spent_usd": round(self.spend.spent_usd, 4)})
            finally:
                wb.lock.release()

        return self.streamer.lines(run, work)

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self.sessions.clear()
            self.cache.clear()
            dm.create_warehouse(self.warehouse)
        self.dash_file.unlink(missing_ok=True)
        return {"reset": True}
