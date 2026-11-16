"""Neo4j as a memory graph: Claude extracts (subject, relation, object) facts, stored with timestamps; Cypher recalls.

A fact is a FACT relationship between two Entity nodes, with `at` (when it was said) and `current`. A new fact with
the same subject and relation ends the old one (`current` false, `until` set), so £600 stays in the graph as history
but the query for the present sees £450. Neo4j Community in Docker on 127.0.0.1:18610, removed at the end.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/neo4j"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

from neo4j import GraphDatabase  # noqa: E402

compose = ["docker", "compose", "-f", str(HERE / "docker-compose.yml")]
try:
    subprocess.run(compose + ["up", "-d", "--wait", "--wait-timeout", "180"], check=True, capture_output=True, text=True)
except (subprocess.CalledProcessError, FileNotFoundError) as e:
    checks.skip(NAME, f"needs Docker to run neo4j:5.26-community ({str(getattr(e, 'stderr', e))[-150:].strip()})")
    sys.exit(0)

try:
    driver = GraphDatabase.driver("bolt://127.0.0.1:18610", auth=("neo4j", "labpassword"), notifications_min_severity="OFF")
    driver.verify_connectivity()
    with driver.session() as s:
        version = s.run("CALL dbms.components() YIELD versions RETURN versions[0] AS v").single()["v"]

        # Session 1
        for n, (user_msg, _) in enumerate(shared.SESSION_1_TURNS):
            known = [tuple(r.values()) for r in s.run(
                "MATCH (a)-[f:FACT {current:true}]->(b) RETURN a.name AS s, f.relation AS r, b.name AS o")]
            for subj, rel, obj in shared.triples(user_msg, known):
                # End the current fact with this subject and relation, then add the new one.
                s.run("MATCH (:Entity {name:$s})-[f:FACT {relation:$r, current:true}]->(o:Entity) WHERE o.name <> $o "
                      "SET f.current=false, f.until=datetime()", s=subj, r=rel, o=obj)
                s.run("MERGE (a:Entity {name:$s}) MERGE (b:Entity {name:$o}) "
                      "MERGE (a)-[f:FACT {relation:$r, object:$o}]->(b) "
                      "ON CREATE SET f.at=datetime(), f.current=true, f.turn=$n", s=subj, r=rel, o=obj, n=n)
        facts = s.run("MATCH (a)-[f:FACT]->(b) RETURN a.name AS s, f.relation AS r, b.name AS o, f.current AS c ORDER BY f.at").data()
        print(f"{len(facts)} facts in the graph:")
        for f in facts:
            print(f"  {'' if f['c'] else '(ended) '}{f['s']} -{f['r']}-> {f['o']}")
        relations = sorted({f["r"] for f in facts})

        def recall(question: str) -> list[str]:
            pick = shared.claude(f"Question: {question}\nRelations stored about the user: {', '.join(relations)}\n"
                                 "Reply with a JSON list of the relations needed to answer (or that a handbook rule "
                                 "depends on).")
            m = re.search(r"\[.*?\]", pick, re.S)
            try:
                rels = [x for x in json.loads(m.group(0)) if x in relations] if m else []
            except json.JSONDecodeError:
                rels = []
            rows = s.run("MATCH (a:Entity)-[f:FACT {current:true}]->(b) WHERE f.relation IN $rels "
                         "RETURN a.name AS s, f.relation AS r, b.name AS o, toString(f.at) AS at", rels=rels).data()
            return [f"{x['s']} {x['r']} {x['o']} (said {x['at'][:19]})" for x in rows]

        ended = sum(1 for f in facts if not f["c"])
        shared.evaluate(NAME, recall, f"neo4j {version}, {len(facts)} facts, {ended} ended by a correction")
finally:
    subprocess.run(compose + ["down", "-v"], capture_output=True)
