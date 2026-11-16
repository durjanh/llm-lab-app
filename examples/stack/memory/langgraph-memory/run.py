"""LangGraph memory: a checkpointer for short-term (per thread) memory and a Store for long-term (across threads).

Both live in the lab's PostgreSQL container, in their own database `stack_memory`, dropped at the end. The Store has a
semantic index (local BGE vectors in pgvector), so `store.search(namespace, query=...)` is a similarity search.
Session 1 is thread "session-1", session 2 is a new thread with the same user id: the checkpointer starts empty, the
store still knows Sam.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/memory
import shared  # noqa: E402
from common import checks, config  # noqa: E402

NAME = "memory/langgraph-memory"
if not config.HAS_CLAUDE:
    checks.skip(NAME, "set ANTHROPIC_API_KEY in the lab's .env")
    sys.exit(0)

import psycopg  # noqa: E402
from langgraph.checkpoint.postgres import PostgresSaver  # noqa: E402
from langgraph.graph import END, START, MessagesState, StateGraph  # noqa: E402
from langgraph.store.postgres import PostgresStore  # noqa: E402

DB = "stack_memory"
BASE = "postgresql://lab:lab@127.0.0.1:5433"
try:
    admin = psycopg.connect(f"{BASE}/postgres", autocommit=True, connect_timeout=5)
except psycopg.OperationalError:
    checks.skip(NAME, "start the lab's llm-lab-pgvector container (127.0.0.1:5433)")
    sys.exit(0)
admin.execute(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)")
admin.execute(f"CREATE DATABASE {DB}")
try:
    with psycopg.connect(f"{BASE}/{DB}", autocommit=True) as db:
        db.execute("CREATE EXTENSION vector")
    uri = f"{BASE}/{DB}"
    namespace = ("memories", shared.USER_ID)

    with PostgresSaver.from_conn_string(uri) as saver, \
            PostgresStore.from_conn_string(uri, index={"dims": shared.EMBED_DIM, "embed": shared.embed}) as store:
        saver.setup()
        store.setup()

        def chat(state: MessagesState):
            """Reply with Claude, using the thread's own history and the long-term memories."""
            last = state["messages"][-1].content
            found = [h.value["text"] for h in store.search(namespace, query=last, limit=3, filter={"superseded": False})]
            history = "\n".join(f"{m.type}: {m.content}" for m in state["messages"][:-1][-6:])
            reply = shared.claude(f"Memories: {found}\nThis conversation so far:\n{history}\nUser: {last}\nReply in one short sentence.")
            return {"messages": [("assistant", reply)]}

        def remember(state: MessagesState):
            """Write long-term memory: add new facts, flag the ones a correction replaces."""
            last = next(m.content for m in reversed(state["messages"]) if m.type == "human")
            current = [(h.key, h.value["text"]) for h in store.search(namespace, filter={"superseded": False}, limit=50)]
            out = shared.extract(last, current)
            for key, text in current:
                if key in out["supersede"]:
                    store.put(namespace, key, {"text": text, "superseded": True}, index=False)
            for fact in out["add"]:
                store.put(namespace, uuid.uuid4().hex[:8], {"text": fact, "superseded": False})
            return {}

        graph = StateGraph(MessagesState)
        graph.add_node("chat", chat)
        graph.add_node("remember", remember)
        graph.add_edge(START, "chat")
        graph.add_edge("chat", "remember")
        graph.add_edge("remember", END)
        app = graph.compile(checkpointer=saver, store=store)

        # Session 1: one thread; the checkpointer keeps its messages between calls.
        t1 = {"configurable": {"thread_id": shared.SESSION_1}}
        for user_msg, _ in shared.SESSION_1_TURNS:
            app.invoke({"messages": [("user", user_msg)]}, t1)
        n1 = len(app.get_state(t1).values["messages"])
        rows = store.search(namespace, limit=50)
        live = sum(1 for h in rows if not h.value["superseded"])
        print(f"thread {shared.SESSION_1}: {n1} messages checkpointed; store: {len(rows)} memories, {live} current")
        for h in rows:
            print(f"  {'(superseded) ' if h.value['superseded'] else ''}{h.value['text']}")

        # Session 2: a new thread. Short-term memory is empty; long-term memory is not.
        t2 = {"configurable": {"thread_id": shared.SESSION_2}}
        fresh = app.get_state(t2).values.get("messages", [])
        print(f"thread {shared.SESSION_2}: {len(fresh)} messages before the first question")

        def recall(question: str) -> list[str]:
            return [h.value["text"] for h in store.search(namespace, query=question, limit=3, filter={"superseded": False})]

        shared.evaluate(NAME, recall, f"Postgres checkpointer + PostgresStore (semantic index), {n1} messages in thread 1, "
                                      f"{live} of {len(rows)} memories current, thread 2 started with {len(fresh)}")
finally:
    admin.execute(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)")
    admin.close()
