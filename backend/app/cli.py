"""What the command-line scripts in tools/ share (tools/shop_data.py, tools/vector_samples.py): the local embedding
model built from the lab's settings, and turning the failures a person can fix (the database down, a refused input,
a missing file) into one line on stderr and exit code 1, rather than a traceback."""
from __future__ import annotations

import sys
from typing import Callable

from .core.errors import ApiError
from .gateways.local_embeddings import LocalEmbeddings
from .gateways.pgvector import VectorDbUnavailable
from .settings import Settings


def local_embedder(settings: Settings) -> LocalEmbeddings:
    return LocalEmbeddings(settings.local_embed_model, settings.local_openai_url)


def run(command: Callable[[], int]) -> int:
    """Runs one command and returns its exit code; a failure the message explains is printed, not raised."""
    try:
        return command()
    except (ApiError, VectorDbUnavailable) as exc:
        print(str(exc), file=sys.stderr)
    except OSError as exc:
        print(f"{exc.strerror}: {exc.filename}" if exc.filename else str(exc), file=sys.stderr)
    return 1
