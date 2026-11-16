# Neo4j as a memory graph

**What it is.** Neo4j Community 5.26 in Docker (`neo4j:5.26-community`, bolt on port 18610, heap 256 to 512 MB, page cache 128 MB). Python driver 6.4.1. It runs on its own, apart from `zep/`.

**What kind of memory.** A graph of facts. Claude turns each message into `(subject, relation, object)` triples (`shared.triples`). Each triple is a `FACT` relationship between two `Entity` nodes with `relation`, `at` (a timestamp), and `current`. Writing a fact with the same subject and relation as a current one ends the old one (`current = false`, `until = now`). So £600 stays as history and a query for the present sees £450.

**How it does the task.** For each session 2 question Claude picks which stored relations matter, and a Cypher query returns the current facts with those relations. The answer is then written from them and the handbook section.

**What was surprising.** The first run failed (4/5, £450 lost). Claude had named the subject "data engineering course" in one turn and "Course" in the next, so the correction never matched the old fact. Showing the extractor the facts already stored, so it reuses the same subject and relation, fixed it. That is the main cost of hand-built graph memory: entity naming has to be consistent.

**Limits.** We wrote the supersede rule. Relations such as `PREFERS` can legitimately have several values, which a "one current fact per relation" rule would wrongly end; this task has none.

Ran on 2026-11-15: PASS memory/neo4j: 5/5 answers correct, corrected fact £450 won; neo4j 5.26.33, 11 facts, 1 ended by a correction
