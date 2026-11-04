"""The data agent's warehouse and semantic model: invented engineering activity in SQLite, described as topics.

A semantic model is what lets an agent query data without writing SQL. Each topic names a base table, the joins it
may use, and its fields: dimensions (columns, with timeframes for timestamps) and measures (aggregates). The agent
asks for fields by name; `compile_query` checks every name, filter and limit against the model and builds
parameterised SQL. So the model cannot invent a column, join two tables wrongly, or run anything but a SELECT.

The agent can also extend the model (`define_field`: a new dimension or measure as a SQL expression over the
topic's tables) and, for what the model cannot express, write SQL itself (`run_sql`). Both run on a connection
that can only read, with an authorizer that refuses anything else and a time limit.

Row-level security: the warehouse holds three invented companies, every row tagged with its company_id. Who may see
what is decided by the signed-in person, never by the model. `create_warehouse` also writes one copy per company
holding only that company's rows (`tenant_path`), and every query, whether compiled, from a made field or written by
hand, runs on the signed-in company's copy. The compiler adds `company_id = ?` as well, as an access filter. A filter
inside a shared database is not enough on its own here: SQLite has no row policies, and a view over the shared tables
can be shadowed by a CTE of the same name in the agent's own SQL.

The data is generated, from April 2022 to now: pull requests that grow over time, dip in August and late December,
and take longer to merge when they are larger.
"""
from __future__ import annotations

import math
import random
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

NAMES = ["alex", "sam", "priya", "tom", "maya", "omar", "lucia", "ben", "chen", "ivy", "noah", "zara", "leo", "amara",
         "jonas", "freya", "kai", "nadia", "eli", "sofia", "ravi", "hana", "theo", "isla", "yusuf", "mei", "oscar",
         "ines", "finn", "aisha", "luca", "nora", "arjun", "elsa", "milo", "rosa", "aria", "bruno", "cleo", "dev", "esme",
         "felix", "gia", "hugo", "iris", "jude", "kira", "levi", "mira", "nico", "olga", "pablo", "quinn", "rhea", "silas",
         "tara", "uma", "vik", "wren", "xena"]
COMPANIES = [  # invented; scale sets how busy each one is
    {"id": 1, "name": "Harbourside Labs", "scale": 1.0, "names": NAMES[:36],
     "repos": [("harbour", "TypeScript", 1.0), ("harbour-api", "Python", 0.55), ("harbour-mobile", "Kotlin", 0.3), ("infra", "HCL", 0.18)],
     "teams": {"Platform": 9, "Product": 14, "Data": 7, "Mobile": 6}},
    {"id": 2, "name": "Kestrel Freight", "scale": 0.45, "names": NAMES[36:51],
     "repos": [("kestrel-web", "TypeScript", 1.0), ("routing", "Go", 0.6), ("driver-app", "Swift", 0.35)],
     "teams": {"Web": 6, "Routing": 5, "Apps": 4}},
    {"id": 3, "name": "Larkspur Health", "scale": 0.3, "names": NAMES[51:60],
     "repos": [("portal", "C#", 1.0), ("records-api", "Python", 0.7)], "teams": {"Portal": 5, "Records": 4}},
]
LABELS = ["feature", "bug", "chore", "refactor", "docs", "security"]
START = date(2022, 4, 4)

TIMEFRAMES = {
    "date": "date({c})",
    "week": "date({c}, 'weekday 0', '-6 days')",  # weeks start on Monday
    "month": "strftime('%Y-%m', {c})",
    "quarter": "strftime('%Y', {c}) || '-Q' || ((cast(strftime('%m', {c}) as integer) + 2) / 3)",
    "year": "strftime('%Y', {c})",
    "day_of_week": "case cast(strftime('%w', {c}) as integer) when 0 then '7 Sun' when 1 then '1 Mon' when 2 then '2 Tue' "
                   "when 3 then '3 Wed' when 4 then '4 Thu' when 5 then '5 Fri' else '6 Sat' end",
    "hour": "cast(strftime('%H', {c}) as integer)",
}


@dataclass(frozen=True)
class Viewer:
    """Who is signed in. company_id is what every query is limited to."""
    id: str
    name: str
    company_id: int
    company: str


# Stands in for the identity provider: in a product, the company comes from the verified sign-in token's claims.
VIEWERS = {v.id: v for v in [Viewer("maya", "Maya", 1, "Harbourside Labs"), Viewer("theo", "Theo", 1, "Harbourside Labs"),
                             Viewer("aria", "Aria", 2, "Kestrel Freight"), Viewer("rhea", "Rhea", 3, "Larkspur Health")]}


@dataclass(frozen=True)
class Field:
    name: str  # e.g. "pull_requests.merged_at"
    label: str
    kind: str  # string, number, boolean, timestamp, measure
    sql: str
    description: str
    joins: tuple[str, ...] = ()  # join names this field needs


# ---------- the semantic model ----------

JOINS = {
    "repositories": "LEFT JOIN repositories ON repositories.id = {base}.repository_id",
    "authors": "LEFT JOIN users AS authors ON authors.id = {base}.author_id",
    "pull_requests": "LEFT JOIN pull_requests ON pull_requests.id = reviews.pull_request_id",
    "reviewers": "LEFT JOIN users AS reviewers ON reviewers.id = reviews.reviewer_id",
    "pr_repositories": "LEFT JOIN repositories ON repositories.id = pull_requests.repository_id",
}


def _f(name: str, label: str, kind: str, sql: str, description: str, *joins: str) -> Field:
    return Field(name, label, kind, sql, description, tuple(joins))


REPO_FIELDS = [
    _f("repositories.name", "Repository Name", "string", "repositories.name", "The repository's name", "repositories"),
    _f("repositories.language", "Repository Language", "string", "repositories.language", "The repository's main language", "repositories"),
]
AUTHOR_FIELDS = [
    _f("authors.login", "Author Login", "string", "authors.login", "Who opened it", "authors"),
    _f("authors.team", "Author Team", "string", "authors.team", "The author's team (look up the values)", "authors"),
]
TOPICS: dict[str, dict[str, Any]] = {
    "pull_requests": {
        "label": "GitHub Pull Requests", "base": "pull_requests",
        "description": "Every pull request: who opened it, where it merged, how big it was and how long it took.",
        "fields": [
            _f("pull_requests.number", "Number", "number", "pull_requests.number", "The PR number within its repository"),
            _f("pull_requests.title", "Title", "string", "pull_requests.title", "The PR title"),
            _f("pull_requests.state", "State", "string", "pull_requests.state", "open, merged or closed (closed without merging)"),
            _f("pull_requests.base_ref", "Base Ref", "string", "pull_requests.base_ref", "The branch it targets, e.g. main or a release branch"),
            _f("pull_requests.draft", "Draft", "boolean", "pull_requests.draft", "Whether it is still a draft"),
            _f("pull_requests.label", "Label", "string", "pull_requests.label", "feature, bug, chore, refactor, docs or security"),
            _f("pull_requests.created_at", "Created At", "timestamp", "pull_requests.created_at", "When it was opened"),
            _f("pull_requests.merged_at", "Merged At", "timestamp", "pull_requests.merged_at", "When it was merged; empty if never merged"),
            _f("pull_requests.closed_at", "Closed At", "timestamp", "pull_requests.closed_at", "When it was merged or closed"),
            _f("pull_requests.additions", "Additions", "number", "pull_requests.additions", "Lines added"),
            _f("pull_requests.deletions", "Deletions", "number", "pull_requests.deletions", "Lines deleted"),
            _f("pull_requests.changed_files", "Changed Files", "number", "pull_requests.changed_files", "Files changed"),
            _f("pull_requests.size", "Size", "string", "case when pull_requests.additions + pull_requests.deletions < 50 then '1 XS' "
               "when pull_requests.additions + pull_requests.deletions < 200 then '2 S' when pull_requests.additions + "
               "pull_requests.deletions < 800 then '3 M' else '4 L' end", "Size bucket by lines changed: XS, S, M or L"),
            *REPO_FIELDS, *AUTHOR_FIELDS,
            _f("pull_requests.count", "Pull Request Count", "measure", "count(*)", "How many pull requests"),
            _f("pull_requests.merged_count", "Merged Count", "measure", "sum(case when pull_requests.merged_at is not null then 1 else 0 end)",
               "How many were merged"),
            _f("pull_requests.merge_rate", "Merge Rate", "measure", "round(avg(case when pull_requests.state = 'open' then null when "
               "pull_requests.merged_at is not null then 1.0 else 0.0 end), 3)", "Share of finished PRs that merged (0 to 1)"),
            _f("pull_requests.avg_hours_to_merge", "Average Hours To Merge", "measure",
               "round(avg((julianday(pull_requests.merged_at) - julianday(pull_requests.created_at)) * 24), 1)",
               "Mean time from opening to merging, in hours, for merged PRs"),
            _f("pull_requests.total_lines_changed", "Total Lines Changed", "measure",
               "sum(pull_requests.additions + pull_requests.deletions)", "Additions plus deletions"),
            _f("pull_requests.distinct_authors", "Distinct Authors", "measure", "count(distinct pull_requests.author_id)",
               "How many different people opened PRs"),
        ],
    },
    "reviews": {
        "label": "GitHub Reviews", "base": "reviews",
        "description": "Code reviews on pull requests: who reviewed, what they decided and when.",
        "fields": [
            _f("reviews.state", "Review State", "string", "reviews.state", "approved, changes_requested or commented"),
            _f("reviews.submitted_at", "Submitted At", "timestamp", "reviews.submitted_at", "When the review was submitted"),
            _f("reviewers.login", "Reviewer Login", "string", "reviewers.login", "Who reviewed", "reviewers"),
            _f("reviewers.team", "Reviewer Team", "string", "reviewers.team", "The reviewer's team", "reviewers"),
            _f("pull_requests.number", "Pull Request Number", "number", "pull_requests.number", "The PR reviewed", "pull_requests"),
            _f("repositories.name", "Repository Name", "string", "repositories.name", "The repository", "pull_requests", "pr_repositories"),
            _f("reviews.count", "Review Count", "measure", "count(*)", "How many reviews"),
            _f("reviews.approval_rate", "Approval Rate", "measure", "round(avg(case when reviews.state = 'approved' then 1.0 else 0.0 end), 3)",
               "Share of reviews that approved"),
            _f("reviews.avg_hours_to_review", "Average Hours To First Review", "measure",
               "round(avg((julianday(reviews.submitted_at) - julianday(pull_requests.created_at)) * 24), 1)",
               "Mean time from the PR opening to this review, in hours", "pull_requests"),
        ],
    },
    "issues": {
        "label": "GitHub Issues", "base": "issues",
        "description": "Issues: bugs, features and chores, their priority and how long they stayed open.",
        "fields": [
            _f("issues.title", "Title", "string", "issues.title", "The issue title"),
            _f("issues.state", "State", "string", "issues.state", "open or closed"),
            _f("issues.kind", "Kind", "string", "issues.kind", "bug, feature or chore"),
            _f("issues.priority", "Priority", "string", "issues.priority", "P0 (urgent) to P3"),
            _f("issues.created_at", "Created At", "timestamp", "issues.created_at", "When it was opened"),
            _f("issues.closed_at", "Closed At", "timestamp", "issues.closed_at", "When it was closed"),
            *REPO_FIELDS, *AUTHOR_FIELDS,
            _f("issues.count", "Issue Count", "measure", "count(*)", "How many issues"),
            _f("issues.open_count", "Open Count", "measure", "sum(case when issues.state = 'open' then 1 else 0 end)", "How many are open"),
            _f("issues.avg_days_to_close", "Average Days To Close", "measure",
               "round(avg(julianday(issues.closed_at) - julianday(issues.created_at)), 1)", "Mean days from opening to closing"),
        ],
    },
}
FIELDS = {t: {f.name: f for f in spec["fields"]} for t, spec in TOPICS.items()}
TOPIC_JOINS = {t: sorted({j for f in spec["fields"] for j in f.joins}) for t, spec in TOPICS.items()}
KINDS = {"string", "number", "boolean", "timestamp", "measure"}
OPS = {"is", "is_not", "gt", "gte", "lt", "lte", "between", "contains", "is_null", "not_null"}
MAX_ROWS = 5000


# ---------- the warehouse ----------

def create_warehouse(path: Path, today: date | None = None, seed: int = 7) -> None:
    """Deterministic invented data for three companies (about 21,000 pull requests), then one copy per company."""
    today = today or date.today()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE repositories (id INTEGER PRIMARY KEY, company_id INT, name TEXT, language TEXT);
        CREATE TABLE users (id INTEGER PRIMARY KEY, company_id INT, login TEXT, team TEXT, joined TEXT);
        CREATE TABLE pull_requests (id INTEGER PRIMARY KEY, company_id INT, repository_id INT, number INT, title TEXT,
          author_id INT, base_ref TEXT, state TEXT, draft INT, label TEXT, created_at TEXT, merged_at TEXT, closed_at TEXT,
          additions INT, deletions INT, changed_files INT);
        CREATE TABLE reviews (id INTEGER PRIMARY KEY, company_id INT, pull_request_id INT, reviewer_id INT, state TEXT,
          submitted_at TEXT);
        CREATE TABLE issues (id INTEGER PRIMARY KEY, company_id INT, repository_id INT, author_id INT, title TEXT, kind TEXT,
          priority TEXT, state TEXT, created_at TEXT, closed_at TEXT);
    """)
    out: dict[str, list[tuple]] = {"repositories": [], "users": [], "pull_requests": [], "reviews": [], "issues": []}
    for c in COMPANIES:
        _company(c, random.Random(seed if c["id"] == 1 else seed * 100 + c["id"]), today, out)
    db.executemany("INSERT INTO companies VALUES (?, ?)", [(c["id"], c["name"]) for c in COMPANIES])
    for table, rows in out.items():
        db.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' * len(rows[0]))})", rows)
    db.executescript(INDEXES)
    db.commit()
    db.close()
    for c in COMPANIES:
        _copy_company(path, c["id"])


INDEXES = ("CREATE INDEX pr_created ON pull_requests(created_at); CREATE INDEX pr_merged ON pull_requests(merged_at);"
           "CREATE INDEX rv_pr ON reviews(pull_request_id);")


def tenant_path(path: Path, company_id: int) -> Path:
    """The copy of the warehouse that holds only one company's rows. Queries run here, never on the shared file."""
    return path.with_name(f"{path.stem}-company-{company_id}.db")


def _copy_company(path: Path, company_id: int) -> None:
    out = tenant_path(path, company_id)
    out.unlink(missing_ok=True)
    db = sqlite3.connect(out)
    db.execute("ATTACH DATABASE ? AS shared", (str(path),))
    for name, sql in db.execute("SELECT name, sql FROM shared.sqlite_master WHERE type = 'table'").fetchall():
        db.execute(sql)
        db.execute(f'INSERT INTO "{name}" SELECT * FROM shared."{name}" WHERE {"id" if name == "companies" else "company_id"} = ?',
                   (company_id,))
    db.commit()
    db.execute("DETACH DATABASE shared")
    db.executescript(INDEXES)
    db.close()


def _company(c: dict[str, Any], rnd: random.Random, today: date, out: dict[str, list[tuple]]) -> None:
    """One company's repositories, people, pull requests, reviews and issues, appended to `out` with global ids."""
    cid, repos = c["id"], c["repos"]
    repo_ids = [len(out["repositories"]) + i + 1 for i in range(len(repos))]
    weights = [w for _, _, w in repos]
    out["repositories"] += [(rid, cid, n, lang) for rid, (n, lang, _) in zip(repo_ids, repos)]
    users = []  # (id, login, team, joined)
    for team, n in c["teams"].items():
        for _ in range(n):
            login = c["names"][len(users)] + "-" + team[0].lower()
            # the first eight were there from the start; the rest joined as the company grew
            joined = START if len(users) < 8 else START + timedelta(days=int(rnd.random() ** 1.6 * (today - START).days * 0.85))
            users.append((len(out["users"]) + len(users) + 1, login, team, joined.isoformat()))
    out["users"] += [(u[0], cid, *u[1:]) for u in users]

    nouns = ["search", "billing", "login", "dashboard", "export", "cache", "onboarding", "API client", "settings",
             "notifications", "audit log", "mobile nav", "permissions", "reports", "upload", "Terraform module"]
    verbs = {"feature": "Add", "bug": "Fix", "chore": "Bump", "refactor": "Refactor", "docs": "Document", "security": "Harden"}
    prs, reviews, issues = out["pull_requests"], out["reviews"], out["issues"]
    numbers = {r: 0 for r in repo_ids}
    days = (today - START).days
    for d in range(days):
        day = START + timedelta(days=d)
        t = d / days
        weekday = day.weekday()
        season = 0.55 if day.month == 8 else 0.35 if (day.month == 12 and day.day > 20) or (day.month == 1 and day.day < 3) else 1.0
        trend = 4 + 26 * t ** 1.8 + (12 * (t - 0.82) * 5 if t > 0.82 else 0)  # a step up once an AI coding tool lands
        rate = trend * season * (0.15 if weekday >= 5 else 1.0) * c["scale"]
        active = [u for u in users if u[3] <= day.isoformat()]
        for _ in range(_poisson(rnd, rate)):
            repo = rnd.choices(repo_ids, weights=weights)[0]
            numbers[repo] += 1
            author = rnd.choice(active)
            label = rnd.choices(LABELS, weights=[30, 25, 18, 12, 10, 5])[0]
            lines = int(math.exp(rnd.gauss(4.3 if label in ("feature", "refactor") else 3.4, 1.1)))
            additions, deletions = int(lines * rnd.uniform(0.55, 0.9)) + 1, int(lines * rnd.uniform(0.1, 0.45))
            created = datetime.combine(day, datetime.min.time()) + timedelta(hours=rnd.uniform(8, 19))
            base = "main" if rnd.random() > 0.06 else rnd.choice(["release/2024.10", "release/2025.06", "develop"])
            hours = math.exp(rnd.gauss(1.6 + 0.35 * math.log1p(lines / 40), 1.0))
            fate = rnd.random()
            merged = closed = None
            state = "merged"
            if created + timedelta(hours=hours) > datetime.combine(today, datetime.min.time()) or fate < 0.03:
                state = "open"
            elif fate < 0.14:
                state = "closed"
                closed = created + timedelta(hours=hours * 1.5)
            else:
                merged = closed = created + timedelta(hours=hours)
            pid = len(prs) + 1
            prs.append((pid, cid, repo, numbers[repo], f"{verbs[label]} {rnd.choice(nouns)}", author[0], base, state,
                        int(state == "open" and rnd.random() < 0.3), label, created.isoformat(" ", "seconds"),
                        merged.isoformat(" ", "seconds") if merged else None, closed.isoformat(" ", "seconds") if closed else None,
                        additions, deletions, max(1, int(lines / rnd.uniform(25, 60)))))
            for k in range(rnd.choices([0, 1, 2, 3], weights=[8, 55, 30, 7])[0]):
                reviewer = rnd.choice([u for u in active if u[0] != author[0]] or active)
                at = created + timedelta(hours=hours * rnd.uniform(0.15, 0.95))
                reviews.append((len(reviews) + 1, cid, pid, reviewer[0], rnd.choices(["approved", "changes_requested", "commented"],
                                                                                         weights=[62, 18, 20])[0], at.isoformat(" ", "seconds")))
        for _ in range(_poisson(rnd, rate * 0.35)):
            kind = rnd.choices(["bug", "feature", "chore"], weights=[50, 35, 15])[0]
            created = datetime.combine(day, datetime.min.time()) + timedelta(hours=rnd.uniform(7, 20))
            open_days = math.exp(rnd.gauss(2.0 if kind == "bug" else 2.8, 1.2))
            closed = created + timedelta(days=open_days)
            done = closed < datetime.combine(today, datetime.min.time()) and rnd.random() > 0.08
            issues.append((len(issues) + 1, cid, rnd.choices(repo_ids, weights=weights)[0],
                           rnd.choice(active)[0], f"{kind.title()}: {rnd.choice(nouns)}", kind,
                           rnd.choices(["P0", "P1", "P2", "P3"], weights=[4, 20, 46, 30])[0], "closed" if done else "open",
                           created.isoformat(" ", "seconds"), closed.isoformat(" ", "seconds") if done else None))


def _poisson(rnd: random.Random, lam: float) -> int:
    n, p, limit = 0, 1.0, math.exp(-lam)
    while True:
        p *= rnd.random()
        if p < limit:
            return n
        n += 1


# ---------- searching the model ----------

def search_model(query: str) -> dict[str, Any]:
    """Topics and fields whose names, labels or descriptions share words with the query, best first."""
    words = {w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2} | {"pr" for w in [query] if "pr" in query.lower().split()}
    synonyms = {"pr": "pull", "prs": "pull", "merged": "merge", "people": "author", "engineers": "author", "team": "team",
                "repo": "repository", "repos": "repository", "bugs": "bug", "reviewers": "reviewer"}
    words |= {synonyms[w] for w in list(words) if w in synonyms}
    scored = []
    for t, spec in TOPICS.items():
        text = f"{t} {spec['label']} {spec['description']}".lower()
        topic_score = sum(w in text for w in words)
        hits = []
        for f in spec["fields"]:
            ftext = f"{f.name} {f.label} {f.description}".lower()
            s = sum(w in ftext for w in words)
            if s:
                hits.append((s, f))
        hits.sort(key=lambda x: -x[0])
        scored.append((topic_score * 2 + sum(s for s, _ in hits[:5]), t, [f.name for _, f in hits[:8]]))
    scored.sort(key=lambda x: -x[0])
    return {"topics": [{"topic": t, "label": TOPICS[t]["label"], "description": TOPICS[t]["description"], "matching_fields": fs}
                       for score, t, fs in scored if score > 0] or
            [{"topic": t, "label": s["label"], "description": s["description"], "matching_fields": []} for t, s in TOPICS.items()]}


def describe_topic(topic: str) -> dict[str, Any]:
    spec = _topic(topic)
    return {"topic": topic, "label": spec["label"], "description": spec["description"],
            "dimensions": [{"field": f.name, "label": f.label, "type": f.kind, "description": f.description}
                           for f in spec["fields"] if f.kind != "measure"],
            "measures": [{"field": f.name, "label": f.label, "description": f.description} for f in spec["fields"] if f.kind == "measure"],
            "timeframes": list(TIMEFRAMES), "note": "Group a timestamp by a timeframe as field:timeframe, e.g. pull_requests.merged_at:week"}


def _topic(topic: str) -> dict[str, Any]:
    if topic not in TOPICS:
        raise QueryError(f"No topic {topic!r}. Topics: {', '.join(TOPICS)}")
    return TOPICS[topic]


class QueryError(ValueError):
    """A query the model cannot answer; the message says what to fix, for the agent to read."""


def define_field(topic: str, spec: dict[str, Any]) -> Field:
    """A field the agent adds to a topic. The name, kind and joins are checked here; the expression is checked by
    running it (the caller does that), on the same read-only, authorised connection as every query."""
    _topic(topic)
    name, sql = str(spec.get("name", "")), str(spec.get("sql", "")).strip()
    if not re.fullmatch(rf"{topic}\.[a-z][a-z0-9_]{{1,40}}", name):
        raise QueryError(f"Name the field {topic}.<snake_case>, e.g. {topic}.large_share.")
    if name in FIELDS[topic]:
        raise QueryError(f"{name} already exists in the model; use it, or choose another name.")
    kind = spec.get("kind", "")
    if kind not in KINDS:
        raise QueryError(f"kind must be one of {', '.join(sorted(KINDS))}.")
    if not sql or len(sql) > 500 or ";" in sql or re.search(r"(?i)\bselect\b", sql):
        raise QueryError("sql must be one expression over the topic's columns (no SELECT, no semicolons), under 500 characters.")
    joins = tuple(spec.get("joins") or ())
    bad = [j for j in joins if j not in TOPIC_JOINS[topic]]
    if bad:
        raise QueryError(f"Joins {', '.join(bad)} are not available in {topic}: use {', '.join(TOPIC_JOINS[topic]) or 'none'}.")
    return Field(name, str(spec.get("label") or name.split(".")[-1].replace("_", " ").title()), kind, sql,
                 str(spec.get("description", ""))[:300], joins)


def _fields(topic: str, custom: list[dict] | None) -> dict[str, Field]:
    fields = dict(FIELDS[topic])
    for spec in custom or []:
        f = define_field(topic, spec)
        fields[f.name] = f
    return fields


def _field(topic: str, ref: str, fields: dict[str, Field] | None = None) -> tuple[Field, str | None]:
    name, _, timeframe = ref.partition(":")
    fields = fields or FIELDS[topic]
    if name not in fields:
        close = [f for f in fields if name.split(".")[-1] in f or f.split(".")[-1] in name][:5]
        raise QueryError(f"No field {name!r} in topic {topic}." + (f" Did you mean {', '.join(close)}?" if close else
                                                                   " Call describe_topic to see the fields."))
    f = fields[name]
    if timeframe:
        if f.kind != "timestamp":
            raise QueryError(f"{name} is not a timestamp, so it has no timeframes.")
        if timeframe not in TIMEFRAMES:
            raise QueryError(f"Timeframe {timeframe!r} is not one of {', '.join(TIMEFRAMES)}.")
    return f, timeframe or None


def lookup_values(path: Path, topic: str, field: str, company_id: int, search: str = "", limit: int = 20,
                  custom: list[dict] | None = None) -> dict[str, Any]:
    """The most common values of a dimension in one company's rows, optionally containing `search`, with counts."""
    spec = _topic(topic)
    f, tf = _field(topic, field, _fields(topic, custom))
    if f.kind == "measure":
        raise QueryError("Measures have no values to look up; choose a dimension.")
    expr = TIMEFRAMES[tf].format(c=f.sql) if tf else f.sql
    joins = " ".join(JOINS[j].format(base=spec["base"]) for j in f.joins)
    sql = f"SELECT {expr} AS value, count(*) AS rows FROM {spec['base']} {joins} WHERE {spec['base']}.company_id = ?"
    params: list[Any] = [company_id]
    if search:
        sql += f" AND cast({expr} as text) LIKE ?"
        params.append(f"%{search}%")
    sql += f" GROUP BY 1 ORDER BY 2 DESC LIMIT {int(min(limit, 50))}"
    rows = _execute(path, sql, params)[1]
    return {"field": field, "values": [{"value": v, "rows": n} for v, n in rows], "count": len(rows)}


def compile_query(q: dict[str, Any], company_id: int) -> tuple[str, list[Any], list[str]]:
    """A query spec as parameterised SQL, and its column names. Every name is checked against the model, and the
    company's access filter comes first in the WHERE clause, whatever the query asked for."""
    topic = q.get("topic", "")
    spec = _topic(topic)
    fields = _fields(topic, q.get("custom_fields"))
    dims = [_field(topic, d, fields) for d in q.get("dimensions", [])]
    measures = [_field(topic, m, fields) for m in q.get("measures", [])]
    if not dims and not measures:
        raise QueryError("Choose at least one dimension or measure.")
    for f, _ in dims:
        if f.kind == "measure":
            raise QueryError(f"{f.name} is a measure; put it under measures.")
    for f, tf in measures:
        if f.kind != "measure" or tf:
            raise QueryError(f"{f.name} is not a measure; put it under dimensions.")
    joins: list[str] = []
    select, columns = [], []

    def need(f: Field) -> None:
        for j in f.joins:
            if j not in joins:
                joins.append(j)

    for f, tf in dims:
        need(f)
        select.append(f'{TIMEFRAMES[tf].format(c=f.sql) if tf else f.sql} AS "{f.name}{":" + tf if tf else ""}"')
        columns.append(f.name + (f":{tf}" if tf else ""))
    for f, _ in measures:
        need(f)
        select.append(f'{f.sql} AS "{f.name}"')
        columns.append(f.name)
    where, params = [f"{spec['base']}.company_id = ?"], [company_id]
    for flt in q.get("filters", []):
        f, tf = _field(topic, flt.get("field", ""), fields)
        if f.kind == "measure":
            raise QueryError(f"Filter on dimensions only; {f.name} is a measure.")
        need(f)
        op, values = flt.get("op", "is"), flt.get("values", [])
        expr = TIMEFRAMES[tf].format(c=f.sql) if tf else f.sql
        if op not in OPS:
            raise QueryError(f"Filter op {op!r} is not one of {', '.join(sorted(OPS))}.")
        if op == "is_null":
            where.append(f"{expr} IS NULL")
        elif op == "not_null":
            where.append(f"{expr} IS NOT NULL")
        elif op in ("is", "is_not"):
            if not values:
                raise QueryError(f"Filter on {f.name} needs values.")
            where.append(f"{expr} {'NOT ' if op == 'is_not' else ''}IN ({', '.join('?' for _ in values)})")
            params += [int(v) if f.kind == "boolean" and isinstance(v, bool) else v for v in values]
        elif op == "contains":
            where.append(f"{expr} LIKE ?")
            params.append(f"%{values[0] if values else ''}%")
        elif op == "between":
            if len(values) != 2:
                raise QueryError("between needs two values: from and to.")
            where.append(f"{expr} >= ? AND {expr} < ?")
            params += values
        else:
            if len(values) != 1:
                raise QueryError(f"{op} needs one value.")
            where.append(f"{expr} {dict(gt='>', gte='>=', lt='<', lte='<=')[op]} ?")
            params += values
    sql = f"SELECT {', '.join(select)} FROM {spec['base']} " + " ".join(JOINS[j].format(base=spec["base"]) for j in joins)
    sql += " WHERE " + " AND ".join(where)
    if dims and measures:
        sql += " GROUP BY " + ", ".join(str(i + 1) for i in range(len(dims)))
    order = []
    for s in q.get("sorts", []):
        col = s.get("field", "")
        if col not in columns:
            raise QueryError(f"Sort by a selected column: {', '.join(columns)}")
        order.append(f'"{col}" {"DESC" if s.get("desc") else "ASC"}')
    if not order and dims:
        order = [f'"{columns[0]}" ASC'] if any(tf for _, tf in dims[:1]) else ([f'"{columns[-1]}" DESC'] if measures else [])
    if order:
        sql += " ORDER BY " + ", ".join(order)
    limit = int(q.get("limit") or 500)
    sql += f" LIMIT {max(1, min(limit, MAX_ROWS))}"
    return sql, params, columns


def run_query(path: Path, q: dict[str, Any], company_id: int) -> tuple[list[dict], str, list[Any], list[str]]:
    sql, params, columns = compile_query(q, company_id)
    rows = [dict(zip(columns, r)) for r in _execute(path, sql, params)[1]]
    return rows, sql, params, columns


# ---------- SQL mode: the agent writes the SQL, the harness decides what may run ----------

SQL_TIMEOUT_S = 5
SCHEMA_NOTES = {
    "repositories": "One row per repository.",
    "users": "Engineers. team is their team; joined is when they started.",
    "pull_requests": "One row per pull request. state is open, closed or merged; merged_at is set only when merged. "
                     "base_ref is the target branch. additions and deletions are lines changed.",
    "reviews": "One row per review submitted on a pull request. state is approved, changes_requested or commented.",
    "issues": "kind is bug, feature or chore; priority P0 (most urgent) to P3; state open or closed.",
}
_ALLOWED = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}


def _readonly(path: Path) -> sqlite3.Connection:
    """A read-only connection that also refuses, statement by statement, anything but reading:
    no writes, no PRAGMA, no ATTACH. The progress handler stops a query that runs too long."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    db.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in _ALLOWED else sqlite3.SQLITE_DENY)
    deadline = time.monotonic() + SQL_TIMEOUT_S
    db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 20_000)
    return db


def describe_schema(path: Path) -> dict[str, Any]:
    """Every table in a company's copy with its columns, types, row count, a note, and the values of columns that
    have only a few. The company columns are left out: the copy holds one company, so there is nothing to filter."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = []
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'companies' ORDER BY rowid"):
            cols = []
            for _, col, kind, *_ in db.execute(f'PRAGMA table_info("{name}")').fetchall():
                if col == "company_id":
                    continue
                c: dict[str, Any] = {"name": col, "type": kind or "TEXT"}
                values = db.execute(f'SELECT DISTINCT "{col}" FROM "{name}" WHERE "{col}" IS NOT NULL LIMIT 13').fetchall()
                if kind == "TEXT" and len(values) <= 12 and not col.endswith("_at"):
                    c["values"] = sorted(v for (v,) in values)
                cols.append(c)
            tables.append({"table": name, "rows": db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0],
                           "note": SCHEMA_NOTES.get(name, ""), "columns": cols})
    finally:
        db.close()
    return {"dialect": "SQLite", "tables": tables,
            "joins": ["pull_requests.repository_id = repositories.id", "pull_requests.author_id = users.id",
                      "reviews.pull_request_id = pull_requests.id", "reviews.reviewer_id = users.id",
                      "issues.repository_id = repositories.id", "issues.author_id = users.id"],
            "timestamps": "Text in UTC, 'YYYY-MM-DD HH:MM:SS'. Group with strftime('%Y-%m', col) for months, "
                          "date(col, 'weekday 0', '-6 days') for weeks starting Monday, "
                          "(julianday(a) - julianday(b)) * 24 for hours between two."}


def check_sql(sql: str) -> str:
    """One SELECT (or WITH ... SELECT) statement, without a trailing semicolon. Everything else is refused
    before it reaches the database; the authorizer refuses it again if this check is ever fooled."""
    text = re.sub(r"--[^\n]*|/\*.*?\*/", " ", sql, flags=re.S).strip().rstrip(";").strip()
    if not text:
        raise QueryError("The SQL is empty.")
    if not re.match(r"(?is)^(select|with)\b", text):
        raise QueryError("Only SELECT queries can run: start with SELECT or WITH.")
    if ";" in re.sub(r"'(?:[^']|'')*'", "''", text):
        raise QueryError("One statement at a time: remove the semicolons.")
    return text


def _execute(path: Path, sql: str, params: list[Any] | tuple = (), limit: int = MAX_ROWS) -> tuple[list[str], list[tuple], bool]:
    """Runs one statement on the read-only, authorised connection: columns, up to `limit` rows, and whether there were
    more. SQLite's own message becomes a QueryError, so the agent can read it and fix its SQL."""
    db = _readonly(path)
    try:
        cur = db.execute(sql, params)
        columns = [d[0] for d in cur.description or []]
        got = cur.fetchmany(limit + 1)
    except sqlite3.DatabaseError as exc:
        msg = str(exc)
        if msg == "interrupted":
            msg = f"The query ran for more than {SQL_TIMEOUT_S} s and was stopped. Aggregate more, or filter first."
        elif "not authorized" in msg:
            msg = "Not allowed: this connection can only read tables."
        raise QueryError(f"SQLite: {msg}") from exc
    finally:
        db.close()
    return columns, got[:limit], len(got) > limit


def run_sql(path: Path, sql: str, limit: int = 500) -> tuple[list[dict], str, list[str], bool]:
    """Runs SQL the agent (or a person) wrote. Returns rows, the SQL run, columns, and whether rows were cut off."""
    text = check_sql(sql)
    columns, rows, truncated = _execute(path, text, limit=max(1, min(int(limit), MAX_ROWS)))
    if len(set(columns)) != len(columns):
        raise QueryError(f"Two columns share a name ({', '.join(columns)}): give each an alias with AS.")
    return [dict(zip(columns, r)) for r in rows], text, columns, truncated
