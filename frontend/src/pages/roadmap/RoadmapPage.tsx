import { Link } from 'react-router';
import './roadmap.css';

/** A GenAI engineering roadmap, three levels deep, with each topic linked to the lab pages that teach or build it. */

interface Topic {
  name: string;
  pages: [string, string][]; // path, label
  note?: string;
}

interface Level {
  name: string;
  goal: string;
  groups: { name: string; topics: Topic[] }[];
}

const LEVELS: Level[] = [
  {
    name: 'Beginner',
    goal: 'The foundations: what a model is, how to call it, and how to make its output dependable.',
    groups: [
      {
        name: 'Foundation',
        topics: [
          {
            name: 'Python, JSON and HTTP',
            pages: [
              ['/live', 'Live Claude'],
              ['/architecture', 'Architecture'],
            ],
            note: 'and the python/ lesson scripts',
          },
          {
            name: 'Models and providers',
            pages: [
              ['/building', 'How LLMs are built'],
              ['/local-model', 'Local model'],
              ['/routing', 'Routing'],
            ],
          },
          {
            name: 'Tokens and context windows',
            pages: [
              ['/tokens', 'Tokens'],
              ['/token-counter', 'Token counter'],
              ['/context', 'Context & cost'],
            ],
          },
          { name: 'Prompt engineering', pages: [['/prompting', 'Prompting']] },
          {
            name: 'Temperature and sampling',
            pages: [
              ['/sampling', 'Sampling'],
              ['/confidence', 'Confidence'],
            ],
          },
          {
            name: 'APIs, SDKs and streaming',
            pages: [
              ['/live', 'Live Claude'],
              ['/transformer', 'Transformer explainer'],
            ],
          },
        ],
      },
      {
        name: 'Build reliably',
        topics: [
          {
            name: 'Structured outputs',
            pages: [
              ['/documents', 'Document automation'],
              ['/prompting', 'Prompting'],
            ],
          },
          { name: 'Function calling', pages: [['/agents', 'Agents & tools']] },
          {
            name: 'Input and output validation',
            pages: [
              ['/guardrails', 'Guardrails'],
              ['/whiteboard', 'AI whiteboard'],
            ],
          },
          { name: 'Prompt-injection awareness', pages: [['/injection', 'Prompt injection']] },
          {
            name: 'Cost and latency basics',
            pages: [
              ['/context', 'Context & cost'],
              ['/resilience', 'Rate limits'],
            ],
          },
          {
            name: 'Testing and logging',
            pages: [
              ['/evals', 'Evals'],
              ['/observability', 'Monitoring and traces'],
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Intermediate',
    goal: 'Real applications: your own data, retrieval, workflows, and knowing whether it works in production.',
    groups: [
      {
        name: 'Knowledge systems',
        topics: [
          { name: 'Embeddings', pages: [['/embeddings', 'Embeddings & RAG']] },
          {
            name: 'RAG and chunking',
            pages: [
              ['/vector-db', 'Vector database'],
              ['/embeddings', 'Embeddings & RAG'],
            ],
          },
          {
            name: 'Vector search',
            pages: [
              ['/vector-db', 'Vector database (pgvector)'],
              ['/search-pipeline', 'Search pipeline'],
            ],
          },
          {
            name: 'Hybrid search and reranking',
            pages: [
              ['/vector-db', 'Vector database'],
              ['/embeddings', 'Embeddings & RAG'],
            ],
          },
          {
            name: 'Metadata and permissions',
            pages: [
              ['/search-pipeline', 'Search pipeline'],
              ['/semantic-cache', 'Semantic cache'],
            ],
            note: 'scoping by user and tenant',
          },
          {
            name: 'Document ingestion',
            pages: [
              ['/content-understanding', 'Content Understanding'],
              ['/search-pipeline', 'Search pipeline'],
            ],
          },
        ],
      },
      {
        name: 'Production applications',
        topics: [
          {
            name: 'Tool workflows and orchestration',
            pages: [
              ['/workflows', 'Agent workflows'],
              ['/harness', 'Harness engineering'],
            ],
          },
          { name: 'FastAPI and web apps', pages: [['/architecture', 'Architecture']], note: 'the lab itself is one' },
          {
            name: 'Evaluation',
            pages: [
              ['/evals', 'Evals'],
              ['/benchmarks', 'Benchmarks'],
            ],
          },
          { name: 'Observability', pages: [['/observability', 'Monitoring and traces']] },
          {
            name: 'Guardrails and access control',
            pages: [
              ['/guardrails', 'Guardrails'],
              ['/claude-code-inside', 'Claude Code behind the scenes'],
            ],
          },
          {
            name: 'Human approval flows',
            pages: [
              ['/coding-agent', 'Coding agent'],
              ['/casework', 'Case handling'],
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Advanced',
    goal: 'Production-grade systems: agents that plan, graphs of knowledge, tuned and served models, and attacking your own app.',
    groups: [
      {
        name: 'Agentic systems',
        topics: [
          {
            name: 'ReAct and planning patterns',
            pages: [
              ['/planning-patterns', 'ReAct and planning patterns'],
              ['/agent-types', 'Agent types'],
            ],
          },
          {
            name: 'State, memory and compaction',
            pages: [
              ['/context-engineering', 'Context engineering'],
              ['/harness', 'Harness engineering'],
              ['/diet', 'Diet planner (memory)'],
            ],
          },
          { name: 'MCP and tool ecosystems', pages: [['/mcp', 'MCP servers']] },
          {
            name: 'Multi-agent coordination',
            pages: [
              ['/workflows', 'Agent workflows'],
              ['/deal-close', 'Closed-deal agents'],
            ],
          },
          {
            name: 'GraphRAG',
            pages: [
              ['/graphrag', 'GraphRAG'],
              ['/code-graph', 'Code knowledge graph'],
            ],
          },
          {
            name: 'Adversarial testing',
            pages: [
              ['/red-team', 'Adversarial testing'],
              ['/injection', 'Prompt injection'],
            ],
          },
        ],
      },
      {
        name: 'Models and infrastructure',
        topics: [
          {
            name: 'LoRA and QLoRA',
            pages: [
              ['/lora', 'Fine-tuning with LoRA'],
              ['/training-at-scale', 'Training at scale'],
            ],
          },
          { name: 'DPO and RLHF', pages: [['/preference-tuning', 'Preference tuning']] },
          { name: 'Model routing', pages: [['/routing', 'Routing']] },
          {
            name: 'vLLM and inference serving',
            pages: [
              ['/transformer-tricks', 'Transformer tricks'],
              ['/local-model', 'Local model'],
            ],
          },
          {
            name: 'Quantisation',
            pages: [
              ['/hardware', 'Hardware for AI'],
              ['/local-model', 'Local model'],
            ],
          },
          {
            name: 'Semantic and KV caching',
            pages: [
              ['/semantic-cache', 'Semantic cache'],
              ['/transformer-tricks', 'Transformer tricks'],
              ['/context', 'Context & cost'],
            ],
          },
          { name: 'Mixture of experts', pages: [['/transformer-tricks', 'Transformer tricks']] },
          {
            name: 'CUDA and kernels',
            pages: [['/hardware', 'Hardware for AI']],
            note: 'the roofline, kernel fusion and tiled attention',
          },
        ],
      },
    ],
  },
];

export default function RoadmapPage() {
  return (
    <main className="page-roadmap">
      <div className="kicker">Foundations · Roadmap</div>
      <h1>A GenAI engineering roadmap, mapped to this lab</h1>
      <p className="lede">
        Three levels, from calling a model to running production AI systems. Each topic links to the pages here that
        explain it or let you build it. Do not try to learn everything at once: build the foundation, make something
        real with your own data, then go deeper.
      </p>
      {LEVELS.map((level, i) => (
        <section key={level.name} className={`rm-level rm-${i}`}>
          <h2>
            <span>{i + 1}</span> {level.name}
          </h2>
          <p className="small muted">{level.goal}</p>
          <div className="rm-groups">
            {level.groups.map((g) => (
              <div key={g.name} className="rm-group">
                <h3>{g.name}</h3>
                <ul>
                  {g.topics.map((t) => (
                    <li key={t.name}>
                      <b>{t.name}</b>
                      <span>
                        {t.pages.map(([path, label], k) => (
                          <span key={path}>
                            {k > 0 && ', '}
                            <Link to={path}>{label}</Link>
                          </span>
                        ))}
                        {t.note && <span className="muted"> ({t.note})</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
