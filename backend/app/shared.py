"""One copy of the model list, prices, refusal-fallback routing and environment settings, shared with the lesson scripts,
and MedAssist's practice systems, shared with examples/medassist.

The scripts in python/ import `common`, `data` and `settings` as top-level modules, so the backend
puts that folder on the import path rather than keeping a second copy. Importing `settings`
(which `common` does) loads the project's .env file.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import importlib  # noqa: E402
import importlib.util  # noqa: E402

from common import (DEFAULT_MODEL, LANGUAGE_PRICE_PER_1K_RECORDS, PRICES, Refused, cost_usd, create,  # noqa: E402
                    describe_usage, make_client, stream, text_of)
from data import HANDBOOK  # noqa: E402
from settings import EnvSettings  # noqa: E402

# The live runs reuse the lesson scripts themselves. Their names start with a digit, so they need importlib.
harness_script = importlib.import_module("11_harness_loop")
skills_script = importlib.import_module("12_agent_skills")


def _load_example(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look their module up while the class is being made
    spec.loader.exec_module(module)
    return module


# MedAssist's practice systems and tool loop, shared with examples/medassist so the page and the command line
# book into the same database under the same rules. Standard library only.
medassist_clinic = _load_example("medassist_clinic", ROOT / "examples" / "medassist" / "clinic.py")
# The Aftercare follow-up agent's hospital record, rules and tools, shared with examples/aftercare (the Claude and
# Agent Framework command lines). Standard library only.
aftercare_ward = _load_example("aftercare_ward", ROOT / "examples" / "aftercare" / "ward.py")

__all__ = ["ROOT", "DEFAULT_MODEL", "LANGUAGE_PRICE_PER_1K_RECORDS", "PRICES", "HANDBOOK", "EnvSettings", "Refused", "cost_usd", "create", "describe_usage",
           "make_client", "stream", "text_of", "harness_script", "skills_script", "medassist_clinic", "aftercare_ward"]
