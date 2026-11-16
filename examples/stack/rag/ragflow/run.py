"""RAG with RAGFlow: create a dataset, upload the handbook, parse it, then ask a chat assistant the gold questions.

RAGFlow is a full server (Elasticsearch, MySQL, MinIO, Redis; about 8 GB RAM), so this SKIPs unless the server answers
on its port. Start it with docker-compose.yml here; set RAGFLOW_API_KEY (made in the web UI) and optionally
RAGFLOW_URL (default http://127.0.0.1:18101). The chat model must be configured in RAGFlow's UI (Model providers:
add Anthropic with ANTHROPIC_API_KEY, then pick it). Retrieval is checked with the SDK's `retrieve`.
"""
import socket
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/rag
import shared
from shared import checks, config, data

NAME = "rag/ragflow"
URL = config.env("RAGFLOW_URL") or "http://127.0.0.1:18101"
KEY = config.env("RAGFLOW_API_KEY")


def reachable() -> bool:
    u = urlparse(URL)
    try:
        socket.create_connection((u.hostname, u.port or 80), timeout=2).close()
        return True
    except OSError:
        return False


def main() -> None:
    from ragflow_sdk import RAGFlow  # imported here so a missing server still shows the code path imports

    rag = RAGFlow(api_key=KEY, base_url=URL)
    dataset = rag.create_dataset(name=f"northwind-{int(time.time())}", chunk_method="naive")
    try:
        # One document per section keeps the section title with its text.
        dataset.upload_documents([{"display_name": f"{t}.txt", "blob": f"{t}\n{body}".encode()} for t, body in data.SECTIONS])
        ids = [d.id for d in dataset.list_documents()]
        dataset.async_parse_documents(ids)
        for _ in range(120):  # wait for parsing
            if all(d.run == "DONE" for d in dataset.list_documents()):
                break
            time.sleep(3)
        chat = rag.create_chat(name=f"northwind-chat-{int(time.time())}", dataset_ids=[dataset.id])
        try:
            session = chat.create_session()

            def answer(question):
                chunks = rag.retrieve(dataset_ids=[dataset.id], question=question, page_size=3)
                sections = [Path(c.document_name).stem for c in chunks]
                reply = ""
                for part in session.ask(question, stream=False):
                    reply = part.content
                return reply, sections

            shared.evaluate(NAME, answer, "RAGFlow dataset + chat assistant")
        finally:
            rag.delete_chats(ids=[chat.id])
    finally:
        rag.delete_datasets(ids=[dataset.id])


if not KEY or not reachable():
    import ragflow_sdk  # noqa: F401  (the client code imports even when the server is absent)

    checks.skip(NAME, "needs the RAGFlow server (docker compose up, about 8 GB RAM) and RAGFLOW_API_KEY")
else:
    main()
