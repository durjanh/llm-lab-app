/* Every entry of the AI tech stack chart, with where it is in the lab. Results are from the runs recorded in
   examples/stack/RESULTS.md and examples/sdks/RESULTS.md. */

export type Status = 'lab' | 'example' | 'needs' | 'explained';
export type Where = [string, string | null]; // [label, lab route] or [repository path, null]
export type Tool = { name: string; status: Status; where: Where[]; note?: string };
export type Area = { name: string; colour: string; folder?: string; tools: Tool[] };

export const STATUS: Record<Status, { label: string; means: string }> = {
  lab: { label: 'on a lab page', means: 'a lab page runs it' },
  example: { label: 'runs as an example', means: 'an example in the repository runs it and passed' },
  needs: {
    label: 'needs a key or setup',
    means: 'the full code is written; it runs once you set a key, have the account or install what its notes say',
  },
  explained: { label: 'explained', means: 'described with code or commands, not run here' },
};

const T = (name: string, status: Status, where: Where[], note?: string): Tool => ({ name, status, where, note });
const S = (area: string, tool: string): Where => [`examples/stack/${area}/${tool}/`, null];
const SDK = (name: string): Where => [`examples/sdks/${name}/`, null];

export const AREAS: Area[] = [
  {
    name: 'LLM',
    colour: '#1f6fd1',
    folder: 'examples/stack/models/',
    tools: [
      T('OpenAI GPT', 'lab', [
        ['GPT beside Claude (Azure OpenAI)', '/coding-agent'],
        ['Token counter', '/token-counter'],
      ]),
      T('Anthropic Claude', 'lab', [['Most of the lab', '/']]),
      T(
        'Google Gemini',
        'needs',
        [S('models', 'llm-gemini'), ['Token counter (Gemma tokenizer)', '/token-counter']],
        'Set GEMINI_API_KEY.',
      ),
      T(
        'Meta Llama',
        'example',
        [S('models', 'llm-llama')],
        'Llama 3.2 in Docker Model Runner: 12/12 answers, JSON correct.',
      ),
      T(
        'Mistral AI',
        'example',
        [S('models', 'llm-mistral')],
        'Mistral in Docker Model Runner: 12/12 answers, JSON correct.',
      ),
      T('Cohere', 'needs', [S('models', 'llm-cohere')], 'Set COHERE_API_KEY.'),
      T(
        'Hugging Face',
        'example',
        [S('models', 'llm-huggingface'), ['Fine-tuning with LoRA', '/lora']],
        'Qwen2.5-1.5B on this Mac: 12/12 answers; its JSON was wrong.',
      ),
      T(
        'Ollama',
        'needs',
        [S('models', 'llm-ollama'), ['Local model', '/local-model']],
        'Install Ollama, then ollama pull llama3.2.',
      ),
      T(
        'vLLM',
        'explained',
        [S('models', 'llm-vllm'), ['Batching and paged attention', '/tricks']],
        'Needs Linux with a GPU; runs when VLLM_BASE_URL is set.',
      ),
    ],
  },
  {
    name: 'Agentic AI',
    colour: '#d9720b',
    folder: 'examples/sdks/',
    tools: [
      T('LangGraph', 'example', [SDK('langgraph')], 'All five tasks pass.'),
      T('CrewAI', 'example', [SDK('crewai')], 'All five tasks pass.'),
      T('Microsoft AutoGen', 'example', [SDK('autogen')], 'All five tasks pass.'),
      T('Agno', 'example', [SDK('agno')], 'All five tasks pass.'),
      T('CAMEL', 'example', [SDK('camel')], 'All five tasks pass; needs the MCP SDK below 2.'),
      T('AWS Strands Agents', 'example', [SDK('strands')], 'All five tasks pass.'),
      T('LlamaIndex Workflows', 'example', [SDK('llamaindex')], 'All five tasks pass; task 5 is a Workflow.'),
      T('Microsoft Agent Framework', 'lab', [
        ['Agent workflows', '/workflows'],
        ['Aftercare', '/aftercare'],
        SDK('agent-framework'),
      ]),
    ],
  },
  {
    name: 'RAG',
    colour: '#2e9e3f',
    folder: 'examples/stack/rag/',
    tools: [
      T('LangChain', 'example', [SDK('langchain')]),
      T('LlamaIndex', 'example', [S('rag', 'llamaindex')], '12/12 answers, 12/12 retrieval.'),
      T('Haystack', 'example', [S('rag', 'haystack')], '12/12 answers, 12/12 retrieval.'),
      T('DSPy', 'example', [S('rag', 'dspy')], '12/12, with a BootstrapFewShot step.'),
      T('RAGFlow', 'needs', [S('rag', 'ragflow')], 'Needs its own server (about 8 GB of memory) and RAGFLOW_API_KEY.'),
      T('GraphRAG', 'lab', [['GraphRAG', '/graphrag']]),
      T('EmbedChain', 'example', [S('rag', 'embedchain')], '12/12; archived in March 2025 and moved into Mem0.'),
      T('Unstructured', 'example', [S('rag', 'unstructured')], 'All 12 sections recovered from a PDF and a Word file.'),
    ],
  },
  {
    name: 'Embedding',
    colour: '#7b3fb8',
    folder: 'examples/stack/models/',
    tools: [
      T(
        'OpenAI Embeddings',
        'lab',
        [
          ['Search pipeline', '/search-pipeline'],
          ['Embeddings', '/embeddings'],
        ],
        'text-embedding-3-large, served through Azure OpenAI in this lab.',
      ),
      T(
        'Azure OpenAI Embed',
        'lab',
        [['Search pipeline', '/search-pipeline'], S('models', 'emb-azure-openai')],
        'text-embedding-3-large, keyless: recall@3 12/12.',
      ),
      T('Cohere Embed', 'needs', [S('models', 'emb-cohere')], 'Set COHERE_API_KEY.'),
      T('Voyage AI', 'needs', [S('models', 'emb-voyage')], 'Set VOYAGE_API_KEY.'),
      T(
        'Sentence Transformers',
        'lab',
        [['Embeddings', '/embeddings'], S('models', 'emb-minilm')],
        'MiniLM: recall@3 12/12.',
      ),
      T('BGE', 'example', [S('models', 'emb-bge')], 'bge-small and bge-base: recall@3 12/12.'),
      T(
        'Vertex AI Embeddings',
        'needs',
        [S('models', 'emb-vertex')],
        'Set GOOGLE_CLOUD_PROJECT and sign in with gcloud.',
      ),
    ],
  },
  {
    name: 'MCP',
    colour: '#c2187a',
    folder: 'examples/stack/mcp-servers/',
    tools: [
      T('MCP SDK', 'lab', [['MCP servers', '/mcp']]),
      T('FastMCP', 'explained', [['MCP servers', '/mcp']], 'The MCP Python SDK 1.x name; the lab uses 2.x.'),
      T('MCP Registry', 'example', [S('mcp-servers', 'registry')], 'Finds GitHub’s server, version 2.1.0.'),
      T('GitHub MCP Server', 'example', [S('mcp-servers', 'github')], 'Read-only; reads this repository.'),
      T('Slack MCP Server', 'needs', [S('mcp-servers', 'slack')], 'Set SLACK_BOT_TOKEN and SLACK_TEAM_ID.'),
      T(
        'PostgreSQL MCP Server',
        'example',
        [S('mcp-servers', 'postgres')],
        'Postgres MCP Pro, restricted mode; a delete is refused.',
      ),
      T('Google Drive MCP', 'needs', [S('mcp-servers', 'google-drive')], 'Set GOOGLE_ACCESS_TOKEN (drive.readonly).'),
      T('Filesystem MCP', 'example', [S('mcp-servers', 'filesystem')], '3/3 answers from files.'),
    ],
  },
  {
    name: 'AI Security',
    colour: '#0f8a7e',
    folder: 'examples/stack/security/',
    tools: [
      T('NeMo Guardrails', 'example', [S('security', 'nemo-guardrails')], '12/12 attacks blocked, no false alarms.'),
      T('Guardrails AI', 'example', [S('security', 'guardrails-ai')], '11/12 attacks; hub validators need a token.'),
      T('Microsoft Presidio', 'example', [S('security', 'presidio')], '23/23 PII values found and redacted.'),
      T('Lakera Guard', 'needs', [S('security', 'lakera')], 'Set LAKERA_GUARD_API_KEY.'),
      T(
        'Prompt Security',
        'explained',
        [S('security', 'prompt-security')],
        'A commercial platform with no public self-serve API.',
      ),
      T(
        'Protect AI (LLM Guard)',
        'example',
        [S('security', 'llm-guard')],
        '12/12 attacks; PII 17/23 (misses NI numbers).',
      ),
      T(
        'Azure Content Safety',
        'lab',
        [['Guardrails', '/guardrails'], S('security', 'azure-content-safety')],
        'Prompt Shields: 11/12.',
      ),
      T('Bedrock Guardrails', 'needs', [S('security', 'bedrock-guardrails')], 'Needs an AWS account.'),
    ],
  },
  {
    name: 'Observability',
    colour: '#1f4fa8',
    folder: 'examples/stack/observability/',
    tools: [
      T('LangSmith', 'needs', [S('observability', 'langsmith'), SDK('langchain')], 'Set LANGSMITH_API_KEY.'),
      T(
        'Langfuse',
        'example',
        [S('observability', 'langfuse')],
        'Self-hosted in Docker: 6/6 traces read back, with spans, tokens and scores.',
      ),
      T(
        'Arize Phoenix',
        'example',
        [S('observability', 'phoenix')],
        'Local, over OpenTelemetry: 6/6 traced; its correctness eval 6/6.',
      ),
      T('W&B Weave', 'needs', [S('observability', 'weave')], 'Set WANDB_API_KEY.'),
      T(
        'TruLens',
        'example',
        [S('observability', 'trulens')],
        'The RAG triad: groundedness 1.00, answer relevance 0.83.',
      ),
      T(
        'Ragas',
        'example',
        [S('observability', 'ragas'), ['Evals', '/evals']],
        'Faithfulness 1.00, answer correctness 0.75, context recall 1.00.',
      ),
      T('Promptfoo', 'example', [S('observability', 'promptfoo')], '6/6 tests, a rubric and an injection check pass.'),
      T('Helicone', 'needs', [S('observability', 'helicone')], 'Set HELICONE_API_KEY; self-hosting is explained.'),
    ],
  },
  {
    name: 'Memory',
    colour: '#d9720b',
    folder: 'examples/stack/memory/',
    tools: [
      T('Mem0', 'example', [S('memory', 'mem0')], '5/5 after a new session; the corrected fact wins.'),
      T(
        'Zep (Graphiti)',
        'example',
        [S('memory', 'zep')],
        'Graphiti on Neo4j: 4/5, the correction invalidates the old fact; Zep Cloud needs ZEP_API_KEY.',
      ),
      T('Letta', 'example', [S('memory', 'letta')], 'Letta server 0.16.8 in Docker: 5/5.'),
      T(
        'LangGraph Memory',
        'example',
        [S('memory', 'langgraph-memory'), SDK('langgraph')],
        'Postgres checkpointer and store: 5/5.',
      ),
      T('Redis', 'example', [S('memory', 'redis')], 'Redis 8 hashes with vectors, and chat history with a TTL: 5/5.'),
      T(
        'PostgreSQL',
        'lab',
        [['Vector database', '/vector-db'], ['Semantic cache', '/semantic-cache'], S('memory', 'postgres')],
        'A memories table with a supersedes link: 5/5.',
      ),
      T('Neo4j', 'example', [S('memory', 'neo4j')], 'Facts as a graph with timestamps: 5/5.'),
      T('Chroma', 'example', [S('memory', 'chroma')], 'In-process, with a superseded flag: 5/5.'),
    ],
  },
  {
    name: 'AI Agent',
    colour: '#2e9e3f',
    folder: 'examples/sdks/',
    tools: [
      T('OpenAI Agents SDK', 'example', [SDK('openai-agents')], 'All five tasks pass.'),
      T('LangChain Agents', 'example', [SDK('langchain')], 'Four of five tasks pass.'),
      T('PydanticAI', 'example', [SDK('pydantic-ai')], 'All five tasks pass.'),
      T('Semantic Kernel', 'example', [SDK('semantic-kernel')], 'All five tasks pass.'),
      T('Google ADK', 'example', [SDK('google-adk')], 'All five tasks pass, through LiteLLM.'),
      T('AWS Bedrock Agents', 'needs', [SDK('bedrock-agents')], 'Needs an AWS account with Bedrock access.'),
      T('Microsoft Foundry', 'lab', [
        ['MedAssist', '/medassist'],
        ['Foundry operations', '/foundry-operations'],
      ]),
    ],
  },
  {
    name: 'Automation',
    colour: '#7b3fb8',
    folder: 'examples/stack/automation/',
    tools: [
      T(
        'n8n',
        'example',
        [S('automation', 'n8n')],
        'n8n in Docker: triage, branch, drafts and a retried flaky step all pass.',
      ),
      T('Zapier', 'needs', [S('automation', 'zapier')], 'Set ZAPIER_WEBHOOK_URL; the Code steps are tested locally.'),
      T('Make', 'needs', [S('automation', 'make')], 'Set MAKE_WEBHOOK_URL; the blueprint is checked but not imported.'),
      T(
        'Power Automate',
        'needs',
        [S('automation', 'power-automate')],
        'Needs a Microsoft 365 licence; the flow definition is checked but not imported.',
      ),
      T(
        'Temporal',
        'example',
        [S('automation', 'temporal')],
        'Workflow and activities on the local dev server: pass, with a real retry.',
      ),
      T(
        'Apache Airflow',
        'example',
        [S('automation', 'airflow')],
        'Airflow 3 DAG with branching and retries, run with dags test: pass.',
      ),
      T('Prefect', 'example', [S('automation', 'prefect')], 'Prefect 3 flow, run locally: pass.'),
      T('Kestra', 'example', [S('automation', 'kestra')], 'Kestra 2 in Docker: pass (a 10.8 GB image).'),
      T(
        'Pipedream',
        'example',
        [S('automation', 'pipedream')],
        'The workflow code passes when run locally with Node; the hosted workflow needs PIPEDREAM_WEBHOOK_URL.',
      ),
    ],
  },
  {
    name: 'Vector Database',
    colour: '#c2187a',
    folder: 'examples/stack/vector-dbs/',
    tools: [
      T(
        'Pinecone',
        'example',
        [S('vector-dbs', 'pinecone')],
        'Pinecone Local emulator: 12/12, recall@10 1.0; the cloud needs PINECONE_API_KEY.',
      ),
      T('Weaviate', 'example', [S('vector-dbs', 'weaviate')], '12/12, recall@10 1.0; p50 1.6 ms.'),
      T('Qdrant', 'example', [S('vector-dbs', 'qdrant')], 'In-process and server: 12/12, recall@10 1.0.'),
      T('Milvus', 'example', [S('vector-dbs', 'milvus')], 'Milvus Lite: 12/12; Standalone needs etcd and MinIO.'),
      T('Chroma', 'example', [S('vector-dbs', 'chroma')], '12/12, recall@10 1.0; p50 0.9 ms.'),
      T(
        'pgvector',
        'lab',
        [['Vector database', '/vector-db'], S('vector-dbs', 'pgvector')],
        'The lab’s own baseline: 12/12, recall@10 1.0.',
      ),
      T('Elasticsearch', 'example', [S('vector-dbs', 'elasticsearch')], '12/12, plus a hybrid BM25 + kNN query.'),
      T('Redis', 'example', [S('vector-dbs', 'redis')], '12/12, recall@10 1.0; p50 0.9 ms.'),
      T(
        'MongoDB Atlas',
        'example',
        [S('vector-dbs', 'mongodb-atlas')],
        'Atlas Local: 12/12; the cloud needs MONGODB_URI.',
      ),
    ],
  },
];
