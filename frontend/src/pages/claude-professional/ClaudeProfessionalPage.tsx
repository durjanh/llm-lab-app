import { ExamMap, type Domain, type Exam } from '../claude-architect/examMap';

/* The exam map for Claude Certified Architect – Professional: every objective in Anthropic's exam guide, with where the
   lab practises it. This exam adds the work around the code: discovery, governance, stakeholders and the life cycle. */

const DEL = '/delivery';

const DOMAINS: Domain[] = [
  {
    n: 1,
    name: 'Solution Design & Architecture',
    weight: 17,
    tasks: [
      {
        id: '1.1',
        title: 'Translate business problems into Claude-based AI solutions',
        labs: [
          ['Delivery: from brief to design', `${DEL}#brief`],
          ['Architecture', '/architecture'],
        ],
        status: 'run',
      },
      {
        id: '1.2',
        title: 'Design end-to-end architectures (input → processing → output → feedback loops)',
        labs: [
          ['Delivery: patterns and the MedAssist loop', `${DEL}#patterns`],
          ['MedAssist architecture', '/medassist/architecture'],
        ],
        status: 'run',
      },
      {
        id: '1.3',
        title: 'Select appropriate architectural patterns (workflow, agentic, augmented LLM)',
        labs: [
          ['Delivery: choosing the pattern', `${DEL}#patterns`],
          ['Agent types', '/agent-types'],
          ['Agent workflows', '/workflows'],
        ],
        status: 'run',
      },
      {
        id: '1.4',
        title: 'Design multi-agent systems and orchestration strategies',
        labs: [
          ['Research team: coordinator and subagents', '/research-team#coordinator'],
          ['Harness: sub-agents as tools', '/harness'],
          ['Agent workflows', '/workflows'],
        ],
        status: 'run',
      },
      {
        id: '1.5',
        title: 'Apply decomposition techniques for complex problem solving',
        labs: [
          ['ReAct and planning patterns', '/planning-patterns'],
          ['Research team: decomposition', '/research-team#decomposition'],
          ['Code review passes', '/review-passes#passes'],
        ],
        status: 'run',
      },
      {
        id: '1.6',
        title:
          'Align solutions to business value pillars (efficiency, transformation, productivity, cost, performance SLAs)',
        labs: [
          ['Delivery: value pillars', `${DEL}#value`],
          ['Delivery: from brief to design', `${DEL}#brief`],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 2,
    name: 'Claude Models, Prompting & Context Engineering',
    weight: 13,
    tasks: [
      {
        id: '2.1',
        title: 'Select appropriate Claude models based on trade-offs',
        labs: [
          ['Routing', '/routing'],
          ['Structured extraction: two models compared', '/extraction#compare'],
          ['Live Claude', '/live'],
        ],
        status: 'run',
      },
      {
        id: '2.2',
        title: 'Design system prompts, templates, and guardrails',
        labs: [
          ['Prompting', '/prompting'],
          ['Claude at work: prompt templates by task', '/claude-at-work#task-types'],
          ['Guardrails', '/guardrails'],
        ],
        status: 'run',
      },
      {
        id: '2.3',
        title: 'Apply prompt engineering techniques (zero-shot, few-shot, chain-of-thought)',
        labs: [
          ['Prompting', '/prompting'],
          ['Reasoning models', '/reasoning-models'],
          ['Structured extraction: few-shot', '/extraction#few-shot'],
        ],
        status: 'run',
      },
      {
        id: '2.4',
        title: 'Optimize context windows and manage token usage',
        labs: [
          ['Context and cost', '/context'],
          ['Context engineering', '/context-engineering'],
          ['Support desk: case facts and trimming', '/support-desk#context'],
        ],
        status: 'run',
      },
      {
        id: '2.5',
        title: 'Implement prompt reuse strategies (caching, modular prompts, Skills)',
        labs: [
          ['Live Claude: caching', '/live'],
          ['Claude Code setup: skills', '/claude-code#skills'],
          ['Deck builder: Skills', '/decks'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 3,
    name: 'Integration',
    weight: 19,
    tasks: [
      {
        id: '3.1',
        title: 'Evaluate tool/agent configuration for capability bloat',
        labs: [
          ['Support desk: least privilege', '/support-desk#tools'],
          ['Delivery: integration choices', `${DEL}#integration`],
        ],
        status: 'run',
      },
      {
        id: '3.2',
        title: 'Analyze authentication and authorization requirements to identify security gaps',
        labs: [
          ['Delivery: authentication and authorisation', `${DEL}#integration`],
          ['Foundry operations: security posture', '/foundry-operations'],
          ['MCP servers', '/mcp'],
        ],
        status: 'run',
        note: 'The brief-to-design tool lists the identity and access questions for each brief.',
      },
      {
        id: '3.3',
        title: 'Evaluate accuracy-latency trade-offs and justify configuration decisions',
        labs: [
          ['Routing', '/routing'],
          ['Structured extraction: two models compared', '/extraction#compare'],
          ['Live Claude: effort', '/live'],
        ],
        status: 'run',
      },
      {
        id: '3.4',
        title: 'Analyze observability challenges and select monitoring strategies at scale',
        labs: [
          ['Monitoring and traces', '/observability'],
          ['Delivery: observability at scale', `${DEL}#observability`],
          ['Foundry operations', '/foundry-operations'],
        ],
        status: 'run',
      },
      {
        id: '3.5',
        title: 'Design a RAG pipeline with appropriate chunking and indexing strategies',
        labs: [
          ['Vector database', '/vector-db'],
          ['Search pipeline', '/search-pipeline'],
          ['Embeddings and RAG', '/embeddings'],
        ],
        status: 'run',
      },
      {
        id: '3.6',
        title: 'Apply retrieval strategies matched to data shape and query pattern',
        labs: [
          ['Search pipeline: four modes scored', '/search-pipeline'],
          ['Vector database: meaning, words or both', '/vector-db'],
          ['GraphRAG: local and global search', '/graphrag'],
        ],
        status: 'run',
      },
      {
        id: '3.7',
        title:
          'Evaluate connection protocols and select the appropriate integration mechanism (MCP, API/CLI, agent-to-agent)',
        labs: [
          ['Delivery: choosing the integration', `${DEL}#integration`],
          ['MCP servers', '/mcp'],
        ],
        status: 'explained',
        note: 'MCP and direct API calls run in the lab; agent-to-agent protocols are explained, not run.',
      },
      {
        id: '3.8',
        title: 'Evaluate progressive discovery vs. monolithic context strategy',
        labs: [
          ['Delivery: progressive discovery', `${DEL}#integration`],
          ['Claude Code behind the scenes: skills load on demand', '/claude-code-inside#skills'],
          ['Context engineering', '/context-engineering'],
        ],
        status: 'explained',
      },
    ],
  },
  {
    n: 4,
    name: 'Evaluation, Testing & Optimization',
    weight: 16,
    tasks: [
      {
        id: '4.1',
        title: 'Define evaluation metrics (accuracy, latency, cost, safety, security)',
        labs: [
          ['Evals', '/evals'],
          ['Structured extraction: accuracy, latency and cost', '/extraction#compare'],
          ['Adversarial testing', '/red-team'],
        ],
        status: 'run',
      },
      {
        id: '4.2',
        title: 'Design evaluation datasets and test frameworks using mixed methodologies',
        labs: [
          ['Evals', '/evals'],
          ['Structured extraction: a labelled set', '/extraction#confidence'],
          ['Code review passes: an answer key', '/review-passes'],
        ],
        status: 'run',
      },
      {
        id: '4.3',
        title: 'Conduct A/B testing and iterative improvements',
        labs: [
          ['Structured extraction: two models compared', '/extraction#compare'],
          ['Code review passes: criteria compared', '/review-passes#criteria'],
        ],
        status: 'run',
      },
      {
        id: '4.4',
        title: 'Diagnose system issues (prompt failure, hallucinations, model mismatch)',
        labs: [
          ['Evals: error analysis', '/evals'],
          ['Monitoring and traces', '/observability'],
          ['Structured extraction: required fields that invite invention', '/extraction#schema'],
        ],
        status: 'run',
      },
      {
        id: '4.5',
        title: 'Optimize token usage, latency, and cost-performance trade-offs',
        labs: [
          ['Context and cost', '/context'],
          ['Semantic cache', '/semantic-cache'],
          ['Routing', '/routing'],
        ],
        status: 'run',
      },
      {
        id: '4.6',
        title: 'Monitor system performance using logging and observability tools',
        labs: [
          ['Monitoring and traces', '/observability'],
          ['Foundry operations: Azure Monitor', '/foundry-operations'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 5,
    name: 'Governance, Safety & Risk Management',
    weight: 14,
    tasks: [
      {
        id: '5.1',
        title: 'Implement guardrails and safety controls',
        labs: [
          ['Guardrails', '/guardrails'],
          ['Adversarial testing', '/red-team'],
          ['Prompt injection', '/injection'],
        ],
        status: 'run',
      },
      {
        id: '5.2',
        title: 'Identify risks, limitations, and failure modes of LLM systems',
        labs: [
          ['Delivery: risks and failure modes', `${DEL}#risks`],
          ['Adversarial testing', '/red-team'],
          ['Confidence', '/confidence'],
        ],
        status: 'run',
      },
      {
        id: '5.3',
        title: 'Apply human-in-the-loop validation strategies',
        labs: [
          ['Case handling: caseworker approval', '/casework'],
          ['Support desk: escalation and handoff', '/support-desk#escalation'],
          ['Confidence: send unsure cases to a person', '/confidence'],
        ],
        status: 'run',
      },
      {
        id: '5.4',
        title: 'Ensure compliance with regulations (e.g., GDPR, HIPAA, FedRAMP)',
        labs: [['Delivery: compliance', `${DEL}#compliance`]],
        status: 'explained',
        note: 'Regulation is applied by people and contracts, not run in a lab; the page sets out what each requires of an LLM system.',
      },
      {
        id: '5.5',
        title: 'Address ethical AI considerations (bias, fairness, transparency)',
        labs: [
          ['Claude at work: check an answer for bias', '/claude-at-work#check'],
          ['Delivery: risks and ethics', `${DEL}#risks`],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 6,
    name: 'Stakeholder Communication & Lifecycle Management',
    weight: 14,
    tasks: [
      {
        id: '6.1',
        title: 'Conduct structured discovery and requirement gathering',
        labs: [
          ['Delivery: discovery', `${DEL}#discovery`],
          ['Delivery: from brief to design', `${DEL}#brief`],
        ],
        status: 'run',
      },
      {
        id: '6.2',
        title: 'Communicate architectural decisions and trade-offs',
        labs: [
          ['Delivery: decision records', `${DEL}#lifecycle`],
          ['Delivery: from brief to design (an ADR draft)', `${DEL}#brief`],
        ],
        status: 'run',
      },
      {
        id: '6.3',
        title: 'Manage stakeholder feedback loops and expectation alignment (including SLAs)',
        labs: [['Delivery: life cycle and SLAs', `${DEL}#lifecycle`]],
        status: 'explained',
      },
      {
        id: '6.4',
        title: 'Document architectures and provide implementation guidance',
        labs: [
          ['Delivery: documentation and handoff', `${DEL}#lifecycle`],
          ['Architecture', '/architecture'],
          ['MedAssist architecture', '/medassist/architecture'],
        ],
        status: 'explained',
        note: "The lab's own README.md and CLAUDE.md are a working example of implementation guidance for a team.",
      },
      {
        id: '6.5',
        title: 'Support lifecycle phases (discovery, design, handoff, monitoring, iteration)',
        labs: [
          ['Delivery: the life cycle', `${DEL}#lifecycle`],
          ['Monitoring and traces', '/observability'],
        ],
        status: 'explained',
      },
    ],
  },
  {
    n: 7,
    name: 'Developer Productivity & Operational Enablement',
    weight: 7,
    tasks: [
      {
        id: '7.1',
        title: 'Configure Claude tools and environments for teams (e.g., Claude Code)',
        labs: [
          ['Claude Code setup', '/claude-code'],
          ['Claude Code behind the scenes', '/claude-code-inside'],
        ],
        status: 'run',
        note: 'examples/claude-code holds a team setup to copy: CLAUDE.md, rules, commands, skills, hooks and a CI review.',
      },
      {
        id: '7.2',
        title: 'Improve developer workflows using AI-assisted tooling',
        labs: [
          ['Coding agent', '/coding-agent'],
          ['Code review passes', '/review-passes'],
          ['Claude Code setup: CI', '/claude-code#ci'],
        ],
        status: 'run',
      },
      {
        id: '7.3',
        title: 'Support debugging and operational issue resolution',
        labs: [
          ['Monitoring and traces', '/observability'],
          ['Rate limits', '/resilience'],
          ['Coding agent', '/coding-agent'],
        ],
        status: 'run',
      },
    ],
  },
];

const PROFESSIONAL: Exam = {
  id: 'professional',
  name: 'Claude Certified Architect – Professional',
  code: 'CCAR-P',
  fee: 175,
  questions: 63,
  pageUrl: 'https://anthropic-partners.skilljar.com/claude-certified-architect-professional-certification',
  item: ['objective', 'objectives'],
  intro: (
    <>
      Every objective in Anthropic’s exam guide, with where to practise it in this lab. Beyond the Foundations exam, it
      tests the work around the code: discovery, integration choices, evaluation, governance and compliance,
      stakeholders, and the life cycle of a delivered system.
    </>
  ),
  audience: (
    <>
      <b>For</b> mid- to senior-level solution architects, AI engineers and technical leads who design, build and
      deliver production Claude systems: typically three years or more in systems architecture and six months or more
      with Claude or a similar model in production, from discovery to operation. Integration is the largest domain, at
      19%.
    </>
  ),
  domains: DOMAINS,
  prepare: (
    <ul>
      <li>
        The guide asks you to build and run one end-to-end solution with retrieval, evaluation and observability:{' '}
        <a href="/vector-db">Vector database</a> or <a href="/search-pipeline">Search pipeline</a> for retrieval,{' '}
        <a href="/evals">Evals</a> and <a href="/extraction">Structured extraction</a> for measurement, and{' '}
        <a href="/observability">Monitoring and traces</a>.
      </li>
      <li>
        Practise architectural decisions (model choice, integration protocol, security trade-offs) with{' '}
        <a href={`${DEL}#brief`}>From brief to design</a>, then compare your answer with the reasoning on the{' '}
        <a href={DEL}>Delivery and governance</a> page.
      </li>
      <li>
        The <a href="/claude-architect">Foundations map</a> covers the agent, tool and Claude Code detail this exam
        builds on.
      </li>
    </ul>
  ),
};

export default function ClaudeProfessionalPage() {
  return (
    <main className="page-claude-professional">
      <ExamMap exam={PROFESSIONAL} />
    </main>
  );
}
