"""Writes what `azd provision` made into the lab's .env, or takes it out again with --remove.

Only the keys below are touched. Every other line, such as ANTHROPIC_API_KEY, stays as it is. The first time, the
old file is copied to .env.before-azd, so the values you had are not lost.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parents[2] / ".env"
KEYS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENTS", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
        "AZURE_SEARCH_ENDPOINT", "FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_MODEL", "AZURE_LANGUAGE_ENDPOINT",
        "AZURE_MEDIA_ENDPOINT", "AZURE_AI_RESOURCE_ID", "AZURE_MEDIA_RESOURCE_ID", "AZURE_SPEECH_REGION",
        "AZURE_SPEECH_RESOURCE_ID", "AZURE_SPEECH_FALLBACK_RESOURCE_ID", "LLM_LAB_SANDBOX",
        "LLM_LAB_SESSIONS_ENDPOINT", "LLM_LAB_SESSIONS_SCOPE"]
MARK = "# Written by azd (infra/hooks/write_env.py): the lab's Azure resources"


def azd_values() -> dict[str, str]:
    out = subprocess.run(["azd", "env", "get-values"], capture_output=True, text=True, check=True).stdout
    values = {}
    for line in out.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip().strip('"')
    return values


def main() -> None:
    remove = "--remove" in sys.argv
    lines = ENV.read_text(encoding="utf-8").splitlines() if ENV.exists() else []
    backup = ENV.with_name(".env.before-azd")
    if ENV.exists() and not backup.exists() and not remove:
        shutil.copy2(ENV, backup)
    kept = [l for l in lines if l.strip() != MARK and l.split("=", 1)[0].strip() not in KEYS]
    while kept and not kept[-1].strip():
        kept.pop()
    if not remove:
        values = azd_values()
        new = [f"{k}={values[k]}" for k in KEYS if values.get(k)]
        kept += ["", MARK, *new]
    ENV.write_text("\n".join(kept) + "\n", encoding="utf-8")
    print(f"{'Removed the azd values from' if remove else 'Wrote the azd values to'} {ENV}"
          + ("" if remove or not backup.exists() else f" (your earlier file is {backup.name})"))


if __name__ == "__main__":
    main()
