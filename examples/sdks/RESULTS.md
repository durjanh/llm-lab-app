# Results

Run with `run_all.py` (task 4 with `--auto-approve`): the first nine SDKs on 2026-10-30, `strands` and `pydantic-ai` on 2026-11-13. `run_all.py` now replaces only the rows it ran, so earlier results are kept.

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
