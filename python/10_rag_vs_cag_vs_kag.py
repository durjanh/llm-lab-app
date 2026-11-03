"""Three ways to give Claude a knowledge base, RAG, CAG and KAG, compared on the same questions.

Companion to the Embeddings & RAG and Context & cost labs. Every strategy answers
the same handbook questions, and the script prints each answer with the tokens
sent, the cost and the time, then a totals table.

  RAG  Retrieve, then generate. Rank handbook sections with the same hybrid
       search as 05_rag.py (embeddings + BM25) and send only the top k.
  CAG  Cache, then generate. Send the whole handbook as a cached system prompt,
       with no retrieval step. On the API, Anthropic's prompt cache keeps the
       processed handbook, which plays the role of a precomputed KV cache.
  KAG  Build a knowledge graph once: Claude extracts (subject, relation, object)
       facts, each linked to its handbook section. For each question, Claude
       plans graph steps and picks start entities, the code walks the graph
       hop by hop, and Claude answers from the facts found, citing each one.

The first default question needs one section. The others have answers spread
across several sections, where top-k retrieval tends to miss pieces.

    python 10_rag_vs_cag_vs_kag.py
    python 10_rag_vs_cag_vs_kag.py "Which rules involve HR?" --only kag --show-graph
    python 10_rag_vs_cag_vs_kag.py --graph graph.json     # build the graph once, reuse it on later runs
"""
from __future__ import annotations

import argparse
import importlib
import json
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from common import cache_tokens, cost_usd, create, describe_usage, ensure_answered, make_client, model_argument, run, text_of
from data import HANDBOOK, HANDBOOK_SECTIONS

QUESTIONS = [
    "How many days of annual leave do I get, and how many can I carry over?",
    "List everything the handbook says I must tell my line manager or get their agreement on.",
    "Which things do I need to tell HR about, and how far in advance?",
]
STRATEGIES = ("rag", "cag", "kag")
SECTIONS = [title for title, _ in HANDBOOK_SECTIONS]
ANSWER_RULES = "Be concise. If the information given does not contain the answer, say you don't know."

GRAPH_SCHEMA = {
    "type": "object",
    "properties": {"facts": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "subject": {"type": "string"},
            "relation": {"type": "string"},
            "object": {"type": "string"},
            "section": {"type": "string", "enum": SECTIONS},
        },
        "required": ["subject", "relation", "object", "section"],
        "additionalProperties": False,
    }}},
    "required": ["facts"],
    "additionalProperties": False,
}
EXTRACT_PROMPT = """Turn the handbook below into a knowledge graph. Each fact is (subject, relation, object) plus the handbook section it comes from.

- Cover every rule, number, deadline and contact in the handbook.
- Name entities with short lowercase names, and use exactly the same name whenever the same thing appears in another section, for example "line manager", "hr", "it service desk".
- Keep amounts, limits and deadlines in the fact, for example ("taxi", "reimbursed only when travelling between", "10pm and 6am").

<handbook>
{handbook}
</handbook>"""

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {"type": "array", "items": {"type": "string"}},
        "start": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["steps", "start"],
    "additionalProperties": False,
}
PLAN_PROMPT = """Plan how to answer the question from a knowledge graph. First write the question as a few short graph steps, such as "find what must be reported to the line manager", then "for each, find the deadline". Then choose up to four start entities, copied exactly from the list. Prefer specific entities over generic ones such as "employee".

<entities>
{entities}
</entities>

Question: {question}"""


@dataclass
class Tally:
    calls: int = 0
    input: int = 0
    cache_read: int = 0
    output: int = 0
    cost: float = 0.0
    seconds: float = 0.0

    def add(self, resp, seconds: float, model: str) -> None:
        u = resp.usage
        write, read = cache_tokens(u)
        self.calls += 1
        self.input += u.input_tokens + write
        self.cache_read += read
        self.output += u.output_tokens
        self.cost += cost_usd(u, model) or 0
        self.seconds += seconds


def call(client, tally: Tally, model: str, **params):
    start = time.perf_counter()
    resp = create(client, model=model, max_tokens=16000, **params)
    ensure_answered(resp)
    tally.add(resp, time.perf_counter() - start, model)
    return resp


# --- RAG -------------------------------------------------------------------

def make_retriever(top_k: int):
    """Hybrid search over handbook sections, as in 05_rag.py. None when fastembed is not installed."""
    try:
        import numpy as np
        from fastembed import TextEmbedding
    except ImportError:
        print("RAG skipped: it needs fastembed. Run: pip install -r python/requirements.txt")
        return None
    rag = importlib.import_module("05_rag")  # reuse its chunking, BM25 and ranking
    chunks = rag.chunk("section", 0, 0)
    texts = [c["text"] for c in chunks]
    embedder = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")
    vectors = np.array(list(embedder.embed(texts)))
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)

    def retrieve(question: str) -> list[dict]:
        query = np.array(list(embedder.embed([question])))[0]
        rank_e = rag.ranks((vectors @ (query / np.linalg.norm(query))).tolist())
        rank_k = rag.ranks(rag.bm25(question, texts))
        score = [1 / (60 + rank_e[i]) + 1 / (60 + rank_k[i]) for i in range(len(chunks))]  # reciprocal rank fusion
        return [chunks[i] for i in sorted(range(len(chunks)), key=lambda i: -score[i])[:top_k]]

    return retrieve


def answer_rag(client, tally, model, question, retrieve):
    picked = retrieve(question)
    print("  retrieved: " + ", ".join(c["source"].removeprefix("handbook: ") for c in picked))
    docs = "\n".join(f'<document index="{n}" source="{c["source"]}">\n{c["text"]}\n</document>'
                     for n, c in enumerate(picked, 1))
    return call(client, tally, model, output_config={"effort": "low"},
                system="Answer using only the documents provided and cite document numbers like [1]. " + ANSWER_RULES,
                messages=[{"role": "user", "content": f"<documents>\n{docs}\n</documents>\n\nQuestion: {question}"}])


# --- CAG -------------------------------------------------------------------

CAG_SYSTEM = [{
    "type": "text",
    "text": f"You answer employee questions using only the handbook below. {ANSWER_RULES}\n\n{HANDBOOK}",
    # The breakpoint sits on the system prompt, so every question reuses the same cached prefix.
    "cache_control": {"type": "ephemeral"},
}]


def answer_cag(client, tally, model, question):
    resp = call(client, tally, model, output_config={"effort": "low"}, system=CAG_SYSTEM,
                messages=[{"role": "user", "content": question}])
    write, read = cache_tokens(resp.usage)
    status = ("read from the cache" if read else "written to the cache" if write
              else "not cached (likely shorter than this model's minimum cacheable prompt)")
    print(f"  whole handbook in context, {status}")
    return resp


# --- KAG -------------------------------------------------------------------

def norm(name: str) -> str:
    return name.strip().lower()


def load_or_build_graph(client, tally, model, path: Path | None) -> list[dict]:
    if path and path.is_file():
        facts = json.loads(path.read_text(encoding="utf-8"))["facts"]
        print(f"Knowledge graph loaded from {path}, so there is no build cost this run.")
    else:
        print("Building the knowledge graph (one call, once per run unless you pass --graph)...")
        resp = call(client, tally, model,
                    output_config={"effort": "medium", "format": {"type": "json_schema", "schema": GRAPH_SCHEMA}},
                    messages=[{"role": "user", "content": EXTRACT_PROMPT.format(handbook=HANDBOOK)}])
        facts = json.loads(text_of(resp))["facts"]
        if path:
            path.write_text(json.dumps({"facts": facts}, indent=2), encoding="utf-8")
            print(f"Saved to {path}.")
    for f in facts:  # one spelling per entity, whether the graph was built or loaded
        f["subject"], f["object"] = norm(f["subject"]), norm(f["object"])
    return facts


def link(facts: list[dict]) -> dict[str, list[int]]:
    """Entity name -> indexes of the facts that mention it."""
    graph = defaultdict(list)
    for i, f in enumerate(facts):
        graph[f["subject"]].append(i)
        if f["object"] != f["subject"]:
            graph[f["object"]].append(i)
    return graph


def walk(facts, graph, start, hops: int, hub_degree: int, max_facts: int) -> tuple[list[list[int]], set[str]]:
    """Breadth-first walk from the start entities. Returns the fact indexes found on each hop, and the hubs skipped.

    Hubs, entities linked to more than hub_degree facts such as "employee", are not
    expanded after the first hop, or the walk would pull in the whole handbook. The
    most specific entities are expanded first, so when max_facts is reached the facts
    left out are the ones about the most general entities.
    """
    per_hop: list[list[int]] = []
    found: set[int] = set()
    seen, frontier, skipped = set(start), set(start), set()
    for hop in range(1, hops + 1):
        this_hop, nxt = [], set()
        for entity in sorted(frontier, key=lambda e: (len(graph[e]), e)):
            if hop > 1 and len(graph[entity]) > hub_degree:
                skipped.add(entity)
                continue
            for i in graph[entity]:
                if i not in found and len(found) < max_facts:
                    found.add(i)
                    this_hop.append(i)
                    f = facts[i]
                    other = f["object"] if f["subject"] == entity else f["subject"]
                    if other not in seen:
                        nxt.add(other)
        per_hop.append(this_hop)
        seen |= nxt
        frontier = nxt
    return per_hop, skipped


def fact_line(i: int, f: dict) -> str:
    return f'[F{i + 1}] {f["subject"]} | {f["relation"]} | {f["object"]}  ({f["section"]})'


def answer_kag(client, tally, model, question, facts, graph, entities: str, hops: int, hub_degree: int, max_facts: int):
    plan = json.loads(text_of(call(
        client, tally, model,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
        messages=[{"role": "user", "content": PLAN_PROMPT.format(entities=entities, question=question)}])))
    start = [e for e in map(norm, plan["start"]) if e in graph]
    for n, step in enumerate(plan["steps"], 1):
        print(f"  plan {n}: {step}")
    print(f"  start: {', '.join(start) or '(no known entity)'}")

    per_hop, skipped = walk(facts, graph, start, hops, hub_degree, max_facts)
    print("  " + " → ".join(f"hop {n}: {len(found)} facts" for n, found in enumerate(per_hop, 1))
          + (f"  (hubs not expanded: {', '.join(sorted(skipped))})" if skipped else ""))
    lines = [fact_line(i, facts[i]) for found in per_hop for i in found]
    if not lines:
        print("  No facts reached, so Claude is not asked to answer.")
        return None
    for line in lines[:8]:
        print("    " + line)
    if len(lines) > 8:
        print(f"    ... and {len(lines) - 8} more")

    facts_text = "\n".join(lines)
    return call(client, tally, model, output_config={"effort": "low"},
                system="Answer using only the facts provided and cite fact numbers like [F2]. " + ANSWER_RULES,
                messages=[{"role": "user", "content": f"<facts>\n{facts_text}\n</facts>\n\nQuestion: {question}"}])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question", nargs="?", help="ask your own question instead of the three built-in ones")
    parser.add_argument("--only", nargs="+", choices=STRATEGIES, default=list(STRATEGIES))
    parser.add_argument("--top-k", type=int, default=3, help="RAG: sections sent to the model")
    parser.add_argument("--hops", type=int, default=2, help="KAG: how far to walk from the start entities")
    parser.add_argument("--hub-degree", type=int, default=12, help="KAG: entities with more facts than this are not expanded")
    parser.add_argument("--max-facts", type=int, default=40, help="KAG: most facts sent to the model")
    parser.add_argument("--graph", type=Path, help="KAG: load the graph from this JSON file, or build it and save it there")
    parser.add_argument("--show-graph", action="store_true", help="KAG: print every fact in the graph")
    model_argument(parser)
    args = parser.parse_args()

    strategies = [s for s in STRATEGIES if s in args.only]
    retrieve = make_retriever(args.top_k) if "rag" in strategies else None
    if retrieve is None and "rag" in strategies:
        strategies.remove("rag")
    if not strategies:
        return

    client = make_client()
    tallies = {s: Tally() for s in strategies}
    build = Tally()
    if "kag" in strategies:
        facts = load_or_build_graph(client, build, args.model, args.graph)
        graph = link(facts)
        entities = "\n".join(sorted(graph))
        print(f"Knowledge graph: {len(facts)} facts linking {len(graph)} entities.")
        if args.show_graph:
            for i, f in enumerate(facts):
                print("  " + fact_line(i, f))

    questions = [args.question] if args.question else QUESTIONS
    for question in questions:
        print(f"\n{'=' * 78}\n{question}")
        for s in strategies:
            print(f"\n{s.upper()}")
            start = time.perf_counter()
            if s == "rag":
                resp = answer_rag(client, tallies[s], args.model, question, retrieve)
            elif s == "cag":
                resp = answer_cag(client, tallies[s], args.model, question)
            else:
                resp = answer_kag(client, tallies[s], args.model, question, facts, graph, entities,
                                  args.hops, args.hub_degree, args.max_facts)
            if resp is None:
                continue
            print("\n" + text_of(resp).strip())
            print(f"[{time.perf_counter() - start:.2f}s · last call: {describe_usage(resp.usage, args.model)}]")

    print(f"\n{'=' * 78}\nTotals over {len(questions)} question(s)\n")
    print(f"{'strategy':<26}{'calls':>6}{'input tokens':>14}{'cache reads':>13}{'output tokens':>15}"
          f"{'cost':>10}{'time':>9}")
    rows = [(s.upper(), tallies[s]) for s in strategies]
    if build.calls:
        rows.append(("KAG graph build (one-off)", build))
    for name, t in rows:
        print(f"{name:<26}{t.calls:>6}{t.input:>14,}{t.cache_read:>13,}{t.output:>15,}"
              f"{'$' + format(t.cost, '.4f'):>10}{t.seconds:>8.1f}s")
    print("\nCache reads are billed at about a tenth of the normal input price.")
    print("KAG is only as good as its graph. Check what was extracted with --show-graph.")


if __name__ == "__main__":
    run(main)
