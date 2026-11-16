# Results

Last run on 2026-11-15 with `run_all.py`. SKIP means the tool needs something the machine does not have (an account, a key, a GPU); the detail says what. Rows not run this time are kept.

| Area | Tool | Result | Time | Detail |
|---|---|---|---|---|
| mcp-servers | filesystem | PASS | 36s | 3/3 answers correct |
| mcp-servers | github | PASS | 18s | heading 'LLM Lab' and latest commit found |
| mcp-servers | google-drive | SKIP | 1s | set GOOGLE_ACCESS_TOKEN to an OAuth token with the drive.readonly scope (steps in NOTES.md) |
| mcp-servers | postgres | PASS | 31s | found Equipment via SQL, table intact (12 rows) |
| mcp-servers | registry | PASS | 2s | 30 postgres and 30 github servers; io.github.github/github-mcp-server 2.1.0 |
| mcp-servers | slack | SKIP | 1s | set SLACK_BOT_TOKEN and SLACK_TEAM_ID (steps in NOTES.md) |
| models | llm-cohere | SKIP | 0s | set COHERE_API_KEY to call Cohere Command |
| models | llm-gemini | SKIP | 0s | set GEMINI_API_KEY (or GOOGLE_API_KEY) from Google AI Studio to call Gemini |
| models | llm-huggingface | FAIL | 30s | 12/12 answers correct, JSON wrong (Qwen/Qwen2.5-1.5B-Instruct, local, bar 8/12) |
| models | llm-llama | PASS | 30s | 12/12 answers correct, JSON valid, repairs/high (ai/llama3.2, local) |
| models | llm-mistral | PASS | 24s | 12/12 answers correct, JSON valid, repairs/high (ai/mistral, local) |
| models | llm-ollama | SKIP | 1s | install Ollama (brew install ollama), start it (ollama serve) and ollama pull llama3.2 |
| models | llm-vllm | SKIP | 0s | set VLLM_BASE_URL (for example http://gpu-box:8000/v1) to a vLLM server; needs Linux with a GPU, see NOTES.md |
| observability | helicone | SKIP | 1s | set HELICONE_API_KEY to route the six questions through Helicone (client and headers build fine) |
| observability | langfuse | PASS | 27s | 6/6 traces read back, 6/6 with retrieval span and generation tokens, 6/6 with a score |
| observability | langsmith | SKIP | 2s | set LANGSMITH_API_KEY to trace and evaluate on LangSmith (the traced app builds fine) |
| observability | phoenix | PASS | 29s | 6/6 LLM spans and 6/6 retriever spans read back (1077 tokens); Phoenix correctness eval judged 6/6 correct |
| observability | promptfoo | PASS | 7s | 6/6 gold tests passed (regex asserts, llm-rubric passed); injection check held; promptfoo 0.125.1 |
| observability | ragas | PASS | 79s | 6/6 answers scored, 6/6 judged correct (6/6 match gold); means faithfulness 1.00, factual_correctness(mode=f1) 0.67, answer_correctness 0.75, llm_context_precision_with_reference 1.00, context_recall 1.00 |
| observability | trulens | PASS | 81s | 6/6 records scored; Context Relevance 0.72, Groundedness 1.00, Answer Relevance 0.83; 6/6 answers match gold |
| observability | weave | SKIP | 2s | set WANDB_API_KEY to trace and evaluate on W&B Weave (ops and evaluation build fine) |
| rag | dspy | PASS | 36s | 12/12 answers correct, 12/12 retrieval hits; optimised with BootstrapFewShot on 4 questions; unoptimised scored 12/12 |
| rag | embedchain | PASS | 26s | 12/12 answers correct, 12/12 retrieval hits; embedchain 0.1.128 App, chroma, top 3 |
| rag | haystack | PASS | 22s | 12/12 answers correct, 12/12 retrieval hits; Pipeline: embedder, retriever, prompt builder, generator |
| rag | llamaindex | PASS | 22s | 12/12 answers correct, 12/12 retrieval hits; VectorStoreIndex, top 3 |
| rag | ragflow | SKIP | 1s | needs the RAGFlow server (docker compose up, about 8 GB RAM) and RAGFLOW_API_KEY |
| rag | unstructured | PASS | 23s | sections recovered docx 12/12, pdf 12/12; gold facts in chunks 12/12 |
| security | azure-content-safety | PASS | 7s | detection 92%, false positives 0%; PII 20/23 found (Azure Language) |
| security | bedrock-guardrails | SKIP | 1s | no usable AWS credentials (NoCredentialsError): set AWS_PROFILE or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and AWS_REGION where Bedrock is available |
| security | guardrails-ai | PASS | 10s | detection 92%, false positives 0% (custom pattern validator); PII 23/23 found; schema checks 3/3 (hub validators skipped: no token) |
| security | lakera | SKIP | 0s | set LAKERA_GUARD_API_KEY (free key at platform.lakera.ai) to call Lakera Guard |
| security | llm-guard | PASS | 22s | detection 100%, false positives 0%; PII 17/23 found (74%), 3 core left; secrets caught |
| security | nemo-guardrails | PASS | 17s | detection 100%, false positives 0%; 12/12 benign answers correct |
| security | presidio | PASS | 2s | 23/23 PII entities found (100%), 0 core values left, 0 false alarms on 4 clean texts |
| security | prompt-security | SKIP | 0s | commercial platform with no public self-serve SDK or free tier: needs a Prompt Security tenant (set PS_PROTECT_URL and PS_APP_ID); see NOTES.md |
| vector-dbs | chroma | PASS | 5s | gold 12/12, filter ok, insert 2.8s, p50 0.9ms, p95 1.1ms, recall@10 1.000 (chromadb 1.5.9, persistent client) |
| vector-dbs | elasticsearch | PASS | 28s | gold 12/12, filter ok, insert 11.5s, p50 4.6ms, p95 9.9ms, recall@10 1.000, hybrid ok (Elasticsearch 9.1.5, heap 768m) |
| vector-dbs | milvus | PASS | 8s | gold 12/12, filter ok, insert 2.0s, p50 7.7ms, p95 28.5ms, recall@10 1.000 (Milvus Lite, HNSW) |
| vector-dbs | mongodb-atlas | PASS | 24s | atlas-local 8.0: gold 12/12, filter ok, insert 5.1s, p50 3.3ms, p95 5.4ms, recall@10 1.000; cloud not run, set MONGODB_URI to add it |
| vector-dbs | pgvector | PASS | 26s | gold 12/12, filter ok, insert 25.1s, p50 1.6ms, p95 2.8ms, recall@10 1.000 (HNSW m=16 ef_construction=64 ef_search=100) |
| vector-dbs | pinecone | PASS | 19s | emulator (amd64 image, emulated): gold 12/12, filter ok, insert 12.6s, p50 17.6ms, p95 18.0ms, recall@10 1.000; cloud not run, set PINECONE_API_KEY to add it |
| vector-dbs | qdrant | PASS | 25s | in-process: gold 12/12, filter ok, insert 11.6s, p50 9.5ms, p95 11.8ms, recall@10 1.000; server: gold 12/12, filter ok, insert 4.4s, p50 3.3ms, p95 4.6ms, recall@10 1.000 |
| vector-dbs | redis | PASS | 7s | gold 12/12, filter ok, insert 5.2s, p50 0.9ms, p95 1.3ms, recall@10 1.000 (Redis 8.2.11, HNSW, FT.SEARCH) |
| vector-dbs | weaviate | PASS | 15s | gold 12/12, filter ok, insert 2.3s, p50 1.6ms, p95 2.5ms, recall@10 1.000 (Weaviate 1.33.4, own vectors) |
