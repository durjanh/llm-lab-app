"""Task 1 with LlamaIndex: one call, a typed answer (llm.as_structured_llm(Model).chat -> response.raw)."""
from _li import llm
from llama_index.core.llms import ChatMessage

from shared import checks, tasks

structured = llm().as_structured_llm(tasks.Triage)  # wraps the LLM so every reply is a validated pydantic object
response = structured.chat([ChatMessage(role="system", content=tasks.SYSTEM),
                            ChatMessage(role="user", content=tasks.TRIAGE_PROMPT)])
triage = response.raw
print(triage.model_dump_json(indent=2))
checks.triage_ok(triage)
