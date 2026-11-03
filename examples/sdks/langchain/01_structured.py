"""Task 1, LangChain: one call that returns a typed object. `with_structured_output` binds the pydantic schema."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from azure_model import llm  # noqa: E402
from shared import checks, tasks  # noqa: E402

triage = llm().with_structured_output(tasks.Triage).invoke(tasks.TRIAGE_PROMPT)
print(triage)
checks.triage_ok(triage)
