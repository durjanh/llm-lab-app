"""`.env.example` is committed: it must list every variable python/settings.py reads, its set lines must be the real local
defaults (so a copy runs as it is), and it must never hold a real key or address."""
from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path

from backend.app.shared import EnvSettings

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / ".env.example"
SETTINGS = ROOT / "python" / "settings.py"
NOT_IN_SETTINGS = {"ANTHROPIC_API_KEY", "ORDER_API_URL"}  # read by the Anthropic SDK, and by an example, not settings.py


def lines() -> list[str]:
    return EXAMPLE.read_text(encoding="utf-8").splitlines()


def set_values() -> dict[str, str]:
    pairs = (line.split("=", 1) for line in lines() if line.strip() and not line.lstrip().startswith("#") and "=" in line)
    return {k.strip(): v.strip() for k, v in pairs}


def test_every_variable_settings_reads_is_listed() -> None:
    read = set(re.findall(r'(?:get|num|switch)\("([A-Z][A-Z0-9_]+)"', SETTINGS.read_text(encoding="utf-8")))
    listed = {m.group(1) for line in lines() if (m := re.match(r"^#?\s*([A-Z][A-Z0-9_]+)=", line))}
    assert read - listed == set(), "add these to .env.example"
    assert listed - read - NOT_IN_SETTINGS == set(), "these are listed but python/settings.py does not read them"


def test_the_set_lines_are_the_local_defaults() -> None:
    values = {k: v for k, v in set_values().items() if k not in NOT_IN_SETTINGS}
    got, want = asdict(EnvSettings.from_env(values)), asdict(EnvSettings())
    assert {k: got[k] for k in want if got[k] != want[k]} == {}, "a set line in .env.example differs from settings.py's default"


def test_no_real_key_or_address_is_set() -> None:
    values = set_values()
    # A key, even a made-up one, is a placeholder: set, it would be sent and fail with 401 instead of "no key".
    assert "ANTHROPIC_API_KEY" not in values and "# ANTHROPIC_API_KEY=sk-ant-your-key-here" in lines()
    for key, value in values.items():
        assert "<" not in value, f"{key}: a placeholder must be commented out, or it is read as a real value"
        assert not re.search(r"azure\.com|windows\.net|azure\.net|devtunnels|\+\d{6,}", value), f"{key} looks real"
    for line in lines():  # commented lines may hold placeholders, never a real number or key
        assert not re.search(r"\+\d{8,}|sk-ant-(?!your-key-here)", line), line
