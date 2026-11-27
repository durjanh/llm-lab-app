"""The small "cognitive core" model (LLM_LAB_CORE_MODEL, about 1B parameters) on this machine's Docker Model Runner,
the same server as the local model, through its Anthropic-compatible API. It costs nothing per token and nothing
leaves the machine. Separate from the lab's shared client, which sends only LLM_LAB_LOCAL_MODEL to the local server,
so this one model can sit beside it without changing what every other page calls."""
from __future__ import annotations

from typing import Any, Protocol

from ..shared import LocalModel


class CoreModelUnavailable(RuntimeError):
    """No core model is set, or the local server did not answer."""


class Core(Protocol):
    model: str

    def create(self, **params: Any) -> Any: ...


class CoreModel:
    def __init__(self, model: str, url: str):
        self.model = model
        self._local = LocalModel(url=url) if model else None

    def create(self, **params: Any) -> Any:
        """A Messages API call to the core model; `model` in `params` is ignored."""
        if self._local is None:
            raise CoreModelUnavailable("No core model is set. Set LLM_LAB_CORE_MODEL and run ./tools/local-model.sh "
                                       "--core.")
        try:
            return self._local.create({**params, "model": self.model})
        except Exception as exc:
            if type(exc).__name__ == "ModelUnavailable":  # the local server is down: name this model and its script
                raise CoreModelUnavailable(f"The core model {self.model} is not answering. Start Docker Desktop, "
                                           "then run ./tools/local-model.sh --core.") from exc
            raise
