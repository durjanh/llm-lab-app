import './ai103.css';

type Status = 'run' | 'explained';
type Skill = { skill: string; labs: [string, string][]; status?: Status; note?: string };
type Group = { title: string; skills: Skill[] };
type Area = { area: string; weight: string; groups: Group[] };

const G = '/guardrails',
  CU = '/content-understanding',
  IMG = '/image-generation',
  SRCH = '/search-pipeline',
  TR = '/translation-speech',
  OPS = '/foundry-operations',
  CODE = '/coding-agent',
  DATA = '/data-agent';

/** The study guide's skills measured as of 16 April 2026, each mapped to where the lab lets you practise it. */
const AREAS: Area[] = [
  {
    area: 'Plan and manage an Azure AI solution',
    weight: '25–30%',
    groups: [
      {
        title: 'Choose the appropriate Foundry services for generative AI and agents',
        skills: [
          {
            skill:
              'Choose an appropriate model for each task: LLMs, small language models, multimodal models and Foundry Tools',
            labs: [
              ['Model routing', '/routing'],
              ['Review analysis (Foundry Tools or a model)', '/reviews'],
              ['Translation (Translator or a model)', TR],
            ],
          },
          {
            skill:
              'Choose Foundry services for generation, grounding, vector search, agent workflows or multimodal processing',
            labs: [
              ['Case handling on Azure', '/casework'],
              ['Content Understanding', CU],
              ['Search pipeline', SRCH],
            ],
          },
          {
            skill: 'Choose a method for retrieval and indexing',
            labs: [
              ['Embeddings and RAG', '/embeddings'],
              ['Search pipeline: four modes scored', SRCH],
            ],
          },
          {
            skill: 'Choose memory, tool and knowledge integration services for agents',
            labs: [
              ['MedAssist (File Search, Code Interpreter)', '/medassist'],
              ['Context engineering', '/context-engineering'],
              ['MCP servers', '/mcp'],
              ['Data agent (a semantic model as knowledge)', DATA],
            ],
          },
        ],
      },
      {
        title: 'Set up AI solutions in Foundry',
        skills: [
          {
            skill: 'Design Azure infrastructure for AI apps and agents',
            labs: [
              ['Foundry operations', OPS],
              ['Rate limits and resilience', '/resilience'],
              ['Coding agent: the sandbox in Container Apps', CODE],
            ],
            note: 'infra/ in the repository: azd up builds every resource the lab uses in one resource group, and azd down removes it.',
          },
          { skill: 'Choose deployment options', labs: [['Foundry operations: deployment types', OPS]] },
          {
            skill: 'Configure model and agent deployments',
            labs: [
              ['Foundry operations: live deployments and Bicep', OPS],
              ['MedAssist (agent versions)', '/medassist'],
            ],
            note: 'infra/resources.bicep: capacity, version policy and guardrail for each deployment.',
          },
          {
            skill: 'Integrate Foundry projects with CI/CD pipelines',
            labs: [['Foundry operations: the pipeline', OPS]],
            status: 'explained',
            note: '.github/workflows/infra.yml runs azd provision and then the evaluation gate, signed in with OpenID Connect; infra/pipeline.sh sets it up. The gate and what-if run here; the workflow has not had its first run in GitHub yet.',
          },
        ],
      },
      {
        title: 'Manage, monitor and secure AI systems',
        skills: [
          {
            skill: 'Manage quotas, scaling, rate limits and cost footprints',
            labs: [
              ['Foundry operations: quotas and headers', OPS],
              ['Rate limits and resilience', '/resilience'],
              ['Context and cost', '/context'],
            ],
          },
          {
            skill: 'Monitor model performance, drift, safety events and grounding quality',
            labs: [
              ['Foundry operations: Azure Monitor', OPS],
              ['Guardrails: groundedness', G],
            ],
          },
          {
            skill: 'Monitor data ingestion quality, search index health and relevance',
            labs: [['Search pipeline: ingestion report, index statistics, relevance', SRCH]],
          },
          {
            skill: 'Configure security: managed identity, private networking, keyless credentials, role policies',
            labs: [
              ['Foundry operations: security posture', OPS],
              ['Coding agent: the sandbox sign-in', CODE],
            ],
            note: "Every Azure call in the lab is keyless. infra/ switches key sign-in off on every resource, grants data-plane roles, and lets the pipeline grant only the lab's roles, by a role-assignment condition.",
          },
        ],
      },
      {
        title: 'Implement responsible AI across generative AI and agentic systems',
        skills: [
          {
            skill: 'Configure safety filters, guardrails, risk detection and content moderation',
            labs: [['Guardrails', G]],
          },
          {
            skill: 'Apply responsible AI instrumentation: evaluators, safety evaluations, explanation tooling',
            note: "examples/foundry-sdk: built-in evaluators in Foundry. The safety evaluators are not offered in UK South, the lab's region.",
            labs: [
              ['Guardrails: test set', G],
              ['Foundry operations: evaluators', OPS],
              ['Evals', '/evals'],
            ],
          },
          {
            skill: 'Implement auditing with trace logging, provenance metadata and approval workflows',
            labs: [
              ['Case handling (hash-chained audit)', '/casework'],
              ['Foundry operations: tracing', OPS],
              ['Image generation: Content Credentials', IMG],
            ],
          },
          {
            skill: 'Govern agent behaviour with oversight modes, constraints and tool-access controls',
            labs: [
              ['Harness', '/harness'],
              ['Aftercare (rules in code)', '/aftercare'],
              ['MCP servers (gated writes)', '/mcp'],
              ['Coding agent: permission modes, deny rules, sandbox', CODE],
            ],
          },
        ],
      },
    ],
  },
  {
    area: 'Implement generative AI and agentic solutions',
    weight: '30–35%',
    groups: [
      {
        title: 'Build generative applications by using Foundry',
        skills: [
          {
            skill: 'Deploy and consume LLMs, small models, code models and multimodal models',
            labs: [
              ['Foundry operations', OPS],
              ['Content Understanding: vision', CU],
              ['Coding agent (Claude or a GPT deployment)', CODE],
            ],
          },
          {
            skill: 'Implement retrieval-augmented generation in an application',
            labs: [
              ['Embeddings and RAG', '/embeddings'],
              ['Case handling', '/casework'],
              ['Search pipeline: agent tool', SRCH],
            ],
          },
          {
            skill: 'Design workflows, tool-augmented flows and multistep reasoning pipelines',
            labs: [
              ['Case handling', '/casework'],
              ['Agents and tools', '/agents'],
            ],
          },
          {
            skill: 'Evaluate models and apps: fabrications, relevance, quality and safety',
            labs: [
              ['Foundry operations: evaluators', OPS],
              ['Guardrails', G],
              ['Evals', '/evals'],
            ],
            note: "examples/foundry-sdk/tour.py evaluate: Foundry's built-in evaluators run as a cloud evaluation, with the report in the portal.",
          },
          {
            skill: 'Integrate generative workflows with Foundry SDKs and connectors',
            labs: [
              ['MedAssist (azure-ai-projects)', '/medassist'],
              ['Aftercare (Agent Framework)', '/aftercare'],
            ],
            note: 'examples/foundry-sdk/tour.py: connections, deployments, datasets, indexes, evaluations and tracing through the project client.',
          },
          {
            skill: 'Configure an application to connect to a Foundry project',
            labs: [
              ['MedAssist', '/medassist'],
              ['Aftercare', '/aftercare'],
            ],
          },
        ],
      },
      {
        title: 'Build agents by using Foundry',
        skills: [
          {
            skill: 'Define agent roles, goals, conversation tracking and tool schemas',
            labs: [
              ['MedAssist', '/medassist'],
              ['Aftercare', '/aftercare'],
            ],
          },
          {
            skill: 'Build agents with retrieval, function calling and conversation memory',
            labs: [
              ['MedAssist', '/medassist'],
              ['Search pipeline: agent tool', SRCH],
            ],
          },
          {
            skill: 'Integrate agent tools: APIs, knowledge stores, search, content understanding, custom functions',
            labs: [
              ['MCP servers', '/mcp'],
              ['Search pipeline', SRCH],
              ['Content Understanding', CU],
              ['Data agent (read-only SQL)', DATA],
            ],
          },
          {
            skill: 'Implement orchestrated multi-agent solutions',
            labs: [
              ['Case handling (multi-agent)', '/casework'],
              ['Agents and tools', '/agents'],
            ],
          },
          {
            skill: 'Build autonomous or semi-autonomous workflows with safeguards and approvals',
            labs: [
              ['Harness', '/harness'],
              ['Case handling (caseworker approval)', '/casework'],
              ['Aftercare (nurse queue)', '/aftercare'],
              ['Coding agent: auto mode and the Stop check', CODE],
            ],
          },
          {
            skill: 'Integrate monitoring, evaluate agent behaviour, perform error analysis',
            labs: [
              ['Aftercare: scripted patients', '/aftercare'],
              ['Foundry operations: tracing', OPS],
            ],
          },
        ],
      },
      {
        title: 'Optimise and operationalise generative AI systems',
        skills: [
          {
            skill: 'Tune generation: prompt engineering and model parameters',
            labs: [
              ['Prompting', '/prompting'],
              ['Sampling', '/sampling'],
              ['Live Claude', '/live'],
            ],
          },
          {
            skill: 'Implement model reflection, chain-of-thought evaluations and self-critique loops',
            labs: [
              ['Reasoning models', '/reasoning-models'],
              ['Case handling (revision loop)', '/casework'],
            ],
          },
          {
            skill: 'Set up observability: tracing, token analytics, safety signals, latency breakdowns',
            labs: [['Foundry operations: tracing and metrics', OPS]],
            note: "examples/foundry-sdk/tour.py trace: the SDK's own OpenTelemetry spans, one per model call, with tokens and timing.",
          },
          {
            skill: 'Orchestrate multiple models, flows, or hybrid LLM and rules engines',
            labs: [
              ['Model routing', '/routing'],
              ['Aftercare (rules in code)', '/aftercare'],
              ['Data agent (a model picks fields, code builds the SQL)', DATA],
            ],
          },
        ],
      },
    ],
  },
  {
    area: 'Implement computer vision solutions',
    weight: '10–15%',
    groups: [
      {
        title: 'Design and implement image- and video-generation solutions',
        skills: [
          { skill: 'Generate images from text prompts and reference media', labs: [['Image generation', IMG]] },
          {
            skill: 'Generate videos from text prompts and reference media',
            labs: [['Image generation: video section', IMG]],
            status: 'explained',
            note: 'Sora 2 is closed to new deployments (2 November 2026); code and limits shown.',
          },
          {
            skill: 'Configure image editing: inpainting, mask-based edits, prompt-driven changes',
            labs: [['Image generation: mask painter', IMG]],
          },
          {
            skill: 'Implement workflows to edit generated videos',
            labs: [['Image generation: remix', IMG]],
            status: 'explained',
          },
          { skill: 'Select and apply generation and editing controls', labs: [['Image generation', IMG]] },
        ],
      },
      {
        title: 'Design and implement multimodal understanding workflows',
        skills: [
          {
            skill: 'Analyse visual context with multimodal models',
            labs: [
              ['Content Understanding: vision', CU],
              ['Coding agent: screenshots of its own work', CODE],
            ],
          },
          {
            skill: 'Concise or detailed captions for one or several images',
            labs: [['Content Understanding: vision', CU]],
          },
          { skill: 'Question answering grounded in visual evidence', labs: [['Content Understanding: vision', CU]] },
          {
            skill: 'Alt text and extended descriptions to accessibility guidelines',
            labs: [['Content Understanding: vision', CU]],
          },
          {
            skill: 'Extract visual characteristics with Content Understanding',
            labs: [['Content Understanding: labDamage', CU]],
          },
          { skill: 'Video analysis to process and interpret segments', labs: [['Content Understanding: video', CU]] },
          {
            skill: 'Single-task and pro-mode Content Understanding pipelines',
            labs: [['Content Understanding: standard and agentic', CU]],
            note: 'Pro mode was a 2025 preview; agentic mode is its successor.',
          },
          {
            skill: 'Identify objects, components or regions in images or video',
            labs: [['Content Understanding: regions', CU]],
          },
        ],
      },
      {
        title: 'Implement responsible AI for multimodal content',
        skills: [
          { skill: 'Filter unsafe or disallowed visual content', labs: [['Guardrails: images', G]] },
          {
            skill: 'Detect and mitigate indirect prompt injection in text embedded in images',
            labs: [['Guardrails: images', G]],
          },
          {
            skill: 'Enforce visual policy rules: watermarks, prohibited symbols, brand use, inappropriate content',
            labs: [
              ['Image generation: watermark and rules', IMG],
              ['Content Understanding: policy', CU],
            ],
          },
        ],
      },
    ],
  },
  {
    area: 'Implement text analysis solutions',
    weight: '10–15%',
    groups: [
      {
        title: 'Apply language model text analysis',
        skills: [
          {
            skill: 'Extract entities, topics, summaries and structured JSON with prompting and Foundry Tools',
            labs: [
              ['Review analysis', '/reviews'],
              ['Translation: complaint log', TR],
            ],
          },
          {
            skill: 'Detect sentiment, tone, safety issues and sensitive content',
            labs: [
              ['Review analysis', '/reviews'],
              ['Guardrails: PII', G],
              ['Translation: tone', TR],
            ],
          },
          { skill: 'Translate with Azure Translator or LLM-powered flows', labs: [['Translation and speech', TR]] },
          {
            skill: 'Customise outputs for domain tasks such as compliance summarisation',
            labs: [
              ['Translation: complaint log', TR],
              ['Document automation', '/documents'],
            ],
          },
        ],
      },
      {
        title: 'Implement speech solutions',
        skills: [
          {
            skill: 'Speech to text and text to speech for agentic interactions',
            labs: [
              ['Aftercare: voice', '/aftercare'],
              ['Tutor', '/tutor'],
            ],
          },
          {
            skill: 'Speech as an agent modality, including custom speech models',
            labs: [
              ['Aftercare', '/aftercare'],
              ['Translation: phrase lists', TR],
            ],
            note: 'Phrase lists run; trained custom speech models are explained.',
          },
          {
            skill: 'Multimodal reasoning from audio inputs',
            labs: [
              ['Translation: audio', TR],
              ['Content Understanding: audio', CU],
            ],
          },
          { skill: 'Translate speech into other languages', labs: [['Translation: speech translation', TR]] },
        ],
      },
    ],
  },
  {
    area: 'Implement information extraction solutions',
    weight: '10–15%',
    groups: [
      {
        title: 'Build retrieval and grounding pipelines',
        skills: [
          { skill: 'Ingest and index documents, images, audio and video', labs: [['Search pipeline', SRCH]] },
          {
            skill: 'Configure semantic, hybrid and vector search for grounding',
            labs: [
              ['Search pipeline', SRCH],
              ['Case handling', '/casework'],
            ],
          },
          {
            skill: 'Enrichment with custom or built-in skills for text, images and layout',
            labs: [['Search pipeline: push pipeline and skillset', SRCH]],
            status: 'explained',
            note: 'Enrichment runs as a push pipeline; the indexer skillset needs a data source and is shown as JSON.',
          },
          {
            skill: 'RAG ingestion including documents and OCR',
            labs: [
              ['Search pipeline', SRCH],
              ['Content Understanding', CU],
            ],
          },
          {
            skill: 'Connect retrieval pipelines to workflows and agent tools',
            labs: [
              ['Search pipeline: agent', SRCH],
              ['Case handling', '/casework'],
            ],
          },
        ],
      },
      {
        title: 'Extract content from documents',
        skills: [
          {
            skill: 'Multimodal pipelines combining OCR, layout and field extraction',
            labs: [['Content Understanding', CU]],
          },
          {
            skill: 'Clean, grounded representations for agents and RAG with Content Understanding',
            labs: [['Content Understanding: Markdown', CU]],
          },
          {
            skill: 'Analyzers producing structured or Markdown output',
            labs: [['Content Understanding: custom analyzers', CU]],
          },
        ],
      },
    ],
  },
];

export default function Ai103Page() {
  const all = AREAS.flatMap((a) => a.groups.flatMap((g) => g.skills));
  const explained = all.filter((s) => s.status === 'explained').length;
  return (
    <main className="page-ai103">
      <div className="kicker">Lab 44 · Exam map</div>
      <h1>AI-103: Developing AI Apps and Agents on Azure</h1>
      <p className="lede">
        Every skill Microsoft lists for the exam (skills measured as of 16 April 2026), with where to practise it in
        this lab. {all.length} skills: {all.length - explained} run here against real Azure resources, {explained} are
        explained with working code where something outside the lab is needed. The six labs built for the exam are{' '}
        <a href={G}>guardrails</a>, <a href={CU}>Content Understanding</a>, <a href={IMG}>image generation</a>,{' '}
        <a href={SRCH}>the search pipeline</a>, <a href={TR}>translation and speech</a> and{' '}
        <a href={OPS}>Foundry operations</a>.
      </p>
      <p className="small muted">
        Source: the{' '}
        <a href="https://learn.microsoft.com/credentials/certifications/resources/study-guides/ai-103">
          AI-103 study guide
        </a>
        . A score of 700 passes. Most questions are on generally available features.
      </p>
      {AREAS.map((a) => (
        <section key={a.area} className="az-panel">
          <h2 style={{ marginTop: 0 }}>
            {a.area} <span className="az-tag muted">{a.weight}</span>
          </h2>
          {a.groups.map((g) => (
            <div key={g.title}>
              <h3>{g.title}</h3>
              <div className="az-table-wrap">
                <table className="az-table">
                  <tbody>
                    {g.skills.map((s) => (
                      <tr key={s.skill}>
                        <td style={{ width: '48%' }}>{s.skill}</td>
                        <td>
                          {s.labs.map(([label, href], i) => (
                            <span key={href + label}>
                              {i > 0 && ' · '}
                              <a href={href}>{label}</a>
                            </span>
                          ))}
                          {s.note && <div className="small muted">{s.note}</div>}
                        </td>
                        <td style={{ width: 90 }}>
                          <span className={`az-tag ${s.status === 'explained' ? 'review' : 'pass'}`}>
                            {s.status === 'explained' ? 'explained' : 'runs here'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
