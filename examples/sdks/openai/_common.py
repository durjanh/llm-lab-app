"""What every plain-OpenAI-SDK script here shares: the Azure client, and JSON schemas for the shared tools.

The plain SDK has no tool decorator and no agent loop: you describe each function as a JSON schema,
send it with the request, run the calls the model asks for yourself, and send the results back.
"""
from __future__ import annotations

import inspect
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable, get_type_hints

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from openai import OpenAI  # noqa: E402
from pydantic import create_model  # noqa: E402

from shared import config  # noqa: E402


def client() -> OpenAI:
    """Azure OpenAI's v1 endpoint with an Entra token callable: no key, no api-version."""
    config.check_ready()
    return OpenAI(base_url=config.AZURE_V1_BASE_URL, api_key=config.azure_token_provider())


def tool_schema(fn: Callable) -> dict:
    """A Chat Completions function tool from a Python function: its signature becomes the parameters,
    its docstring the description (with the "Args:" lines as per-parameter descriptions)."""
    doc = inspect.getdoc(fn) or ""
    summary = doc.split("\n\n")[0].replace("\n", " ")
    arg_docs = dict(re.findall(r"^\s*(\w+): (.+)$", doc.split("Args:")[1], re.M)) if "Args:" in doc else {}
    hints = get_type_hints(fn)  # resolves string annotations (the shared tools use `from __future__ import annotations`)
    fields = {name: (hints[name], p.default if p.default is not inspect.Parameter.empty else ...)
              for name, p in inspect.signature(fn).parameters.items()}
    schema = create_model(fn.__name__, **fields).model_json_schema()
    for name, prop in schema.get("properties", {}).items():
        prop.pop("title", None)
        if name in arg_docs:
            prop["description"] = arg_docs[name]
    schema.pop("title", None)
    return {"type": "function", "function": {"name": fn.__name__, "description": summary, "parameters": schema}}


def call(fns: dict[str, Callable], name: str, arguments: str) -> Any:
    """Runs one tool call the model asked for. Bad JSON or an unknown tool becomes an error the model can read."""
    try:
        return fns[name](**json.loads(arguments or "{}"))
    except Exception as exc:  # noqa: BLE001 - the model gets the error and can try again
        return {"error": f"{type(exc).__name__}: {exc}"}
