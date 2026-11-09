"""Writes what `azd provision` made into the lab's .env, or takes it out again with --remove.

--only KEY,KEY touches just those keys and leaves every other line alone, for a script that adds one part to a lab
set up another way (examples/medassist/setup-texts.sh). --values FILE takes the values from a deployment's outputs
(JSON, as `az deployment group create --query properties.outputs` prints them) instead of from azd.

Only the keys below are touched. Every other line, such as ANTHROPIC_API_KEY, stays as it is. The first time, the
old file is copied to .env.before-azd, so the values you had are not lost.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parents[2] / ".env"
KEYS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENTS", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
        "AZURE_SEARCH_ENDPOINT", "FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_MODEL", "AZURE_LANGUAGE_ENDPOINT",
        "AZURE_MEDIA_ENDPOINT", "AZURE_AI_RESOURCE_ID", "AZURE_MEDIA_RESOURCE_ID", "AZURE_SPEECH_REGION",
        "AZURE_SPEECH_RESOURCE_ID", "AZURE_SPEECH_FALLBACK_RESOURCE_ID",
        "LLM_LAB_SESSIONS_ENDPOINT", "LLM_LAB_SESSIONS_SCOPE", "ORDER_API_URL", "MEDASSIST_SMS_ENDPOINT",
        "MEDASSIST_REMINDERS_TABLE"]
MARK = "# Written by azd (infra/hooks/write_env.py): the lab's Azure resources"
# LLM_LAB_SANDBOX is yours to choose, so it is not written: docker for the container on this machine
# (tools/sandbox.sh), or sessions for the Azure one at LLM_LAB_SESSIONS_ENDPOINT, which is written.


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
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
    keys, mark = (only, f"# Written by azd: {', '.join(only)}") if only else (KEYS, MARK)
    lines = ENV.read_text(encoding="utf-8").splitlines() if ENV.exists() else []
    backup = ENV.with_name(".env.before-azd")
    if ENV.exists() and not backup.exists() and not remove:
        shutil.copy2(ENV, backup)
    kept = [l for l in lines if l.strip() != mark and l.split("=", 1)[0].strip() not in keys]
    while kept and not kept[-1].strip():
        kept.pop()
    if not remove:
        if "--values" in sys.argv:  # a deployment's outputs: {"KEY": {"type": ..., "value": ...}}
            outputs = json.loads(Path(sys.argv[sys.argv.index("--values") + 1]).read_text())
            # ARM changes the case of output names (MEDASSIST_SMS_ENDPOINT comes back as medassisT_SMS_ENDPOINT)
            values = {k.upper(): str(v.get("value", "")) for k, v in outputs.items()}
        else:
            values = azd_values()
        new = [f"{k}={values[k]}" for k in keys if values.get(k)]
        kept += ["", mark, *new]
    ENV.write_text("\n".join(kept) + "\n", encoding="utf-8")
    print(f"{'Removed the azd values from' if remove else 'Wrote the azd values to'} {ENV}"
          + ("" if remove or not backup.exists() else f" (your earlier file is {backup.name})"))


if __name__ == "__main__":
    main()
