# Results

Last run on 2026-11-15 with `run_all.py` (task 4 with `--auto-approve`). It replaces only the rows it ran, so older rows keep their earlier dates (the first nine SDKs 2026-10-30, `strands` and `pydantic-ai` 2026-11-13). SKIP means the SDK needs an account this machine lacks.

| SDK | 01_structured | 02_tools | 03_mcp | 04_agent | 05_multi_agent |
|---|---|---|---|---|---|
| openai | PASS 3s | PASS 8s | PASS 7s | PASS 8s | PASS 3s |
| openai-agents | PASS 3s | PASS 5s | PASS 7s | PASS 9s | PASS 6s |
| claude | PASS 3s | PASS 6s | PASS 8s | PASS 9s | PASS 12s |
| agent-framework | PASS 3s | PASS 5s | PASS 5s | PASS 7s | PASS 13s |
| semantic-kernel | PASS 4s | PASS 5s | PASS 7s | PASS 7s | PASS 6s |
| autogen | PASS 2s | PASS 6s | PASS 7s | PASS 7s | PASS 4s |
| langchain | PASS 3s | PASS 5s | PASS 6s | FAIL 11s | PASS 10s |
| langgraph | PASS 4s | PASS 7s | PASS 8s | PASS 7s | PASS 5s |
| crewai | PASS 5s | PASS 6s | PASS 8s | PASS 6s | PASS 5s |
| strands | PASS 2s | PASS 5s | PASS 5s | PASS 7s | PASS 8s |
| pydantic-ai | PASS 3s | PASS 6s | PASS 6s | PASS 10s | PASS 8s |
| agno | PASS 4s | PASS 4s | PASS 7s | PASS 6s | PASS 8s |
| camel | PASS 17s | PASS 8s | PASS 14s | PASS 8s | PASS 21s |
| llamaindex | PASS 5s | PASS 6s | PASS 16s | PASS 18s | PASS 8s |
| google-adk | PASS 18s | PASS 20s | PASS 15s | PASS 12s | PASS 12s |
| bedrock-agents | SKIP 1s | SKIP 0s | SKIP 1s | SKIP 0s | SKIP 0s |
