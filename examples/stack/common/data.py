"""The data every area shares: the lab's invented Northwind handbook, its chunks, and 12 gold questions.

The handbook comes from python/data.py (loaded by path, so no lab packages are needed). Each gold question belongs to
one section and has a pattern the right answer must contain, so retrieval (did the right section come back?) and
answers (does the reply contain the fact?) can both be checked without a model.
"""
from __future__ import annotations

import importlib.util
import re
from dataclasses import dataclass

from .config import ROOT

_spec = importlib.util.spec_from_file_location("lab_data", ROOT / "python" / "data.py")
_lab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_lab)

SECTIONS: list[tuple[str, str]] = list(_lab.HANDBOOK_SECTIONS)  # (title, text), 12 of them
HANDBOOK: str = _lab.HANDBOOK


@dataclass(frozen=True)
class Chunk:
    id: str  # "annual-leave-2"
    section: str  # "Annual leave"
    text: str


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def chunks() -> list[Chunk]:
    """One chunk per sentence, each prefixed with its section title so it stands on its own (about 55 chunks)."""
    out = []
    for title, text in SECTIONS:
        for i, sentence in enumerate(re.split(r"(?<=\.)\s+", text.strip())):
            out.append(Chunk(f"{_slug(title)}-{i}", title, f"{title}: {sentence}"))
    return out


@dataclass(frozen=True)
class Gold:
    question: str
    section: str  # the section that holds the answer
    answer: str  # a regular expression the right answer contains

    def correct(self, text: str) -> bool:
        return bool(re.search(self.answer, text or "", flags=re.I))


GOLD: list[Gold] = [
    Gold("How many unused days of annual leave can I carry into next year?", "Annual leave", r"\b5\b|\bfive\b"),
    Gold("By what time must I tell my line manager that I am ill?", "Sickness absence", r"10\s?(am|a\.m\.)|10:00"),
    Gold("How many weeks at full pay do partners get?", "Parental leave", r"\b6\b|\bsix\b"),
    Gold("What is the daily limit for meals while travelling?", "Expenses", r"£\s?35"),
    Gold("What is the most a hotel can cost per night in London?", "Travel", r"£\s?180"),
    Gold("How many days a year can I work remotely from abroad?", "Remote working", r"\b20\b|\btwenty\b"),
    Gold("Which extension do I call to report a stolen laptop?", "Equipment", r"4400"),
    Gold("Which button do I use to report a suspicious email?", "Information security", r"Report Phishing"),
    Gold("What is my yearly learning budget?", "Learning and development", r"£\s?1,?000"),
    Gold("In which months do performance reviews happen?", "Performance reviews", r"April[\s\S]*October|October[\s\S]*April"),
    Gold("How much does the company pay into my pension?", "Pensions and benefits", r"6\s?%|six per ?cent"),
    Gold("Above what value must I declare a gift?", "Code of conduct", r"£\s?50"),
]
