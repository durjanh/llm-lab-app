import { ExamMap, type Domain, type Exam } from '../claude-architect/examMap';

/* The exam map for Claude Certified Associate – Foundations: every objective in Anthropic's exam guide, with where the
   lab shows it. The exam is for people who use Claude in claude.ai and the apps, so some objectives are practised in
   the product itself; those are marked "in claude.ai". */

const DOMAINS: Domain[] = [
  {
    n: 1,
    name: 'Prompting and Task Execution',
    weight: 14,
    tasks: [
      {
        id: '1.1',
        title: 'Create effective prompts for business and technical tasks',
        labs: [
          ['Claude at work: prompts by task type', '/claude-at-work#task-types'],
          ['Prompting', '/prompting'],
          ['Live Claude', '/live'],
        ],
        status: 'run',
      },
      {
        id: '1.2',
        title: 'Apply task decomposition techniques to structure complex requests',
        labs: [
          ['Claude at work: decompose a request', '/claude-at-work#task-types'],
          ['ReAct and planning patterns', '/planning-patterns'],
        ],
        status: 'run',
      },
      {
        id: '1.3',
        title: 'Iterate prompts to improve output quality',
        labs: [
          ['Claude at work: prompts by task type', '/claude-at-work#task-types'],
          ['Evals: measure before and after a change', '/evals'],
          ['Prompting', '/prompting'],
        ],
        status: 'run',
      },
      {
        id: '1.4',
        title: 'Adapt prompting strategies based on task type (analysis, research, drafting, brainstorming)',
        labs: [
          ['Claude at work: one goal under two task types', '/claude-at-work#task-types'],
          ['Reasoning models', '/reasoning-models'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 2,
    name: 'Output Evaluation and Validation',
    weight: 21,
    tasks: [
      {
        id: '2.1',
        title: 'Evaluate Claude-generated outputs for accuracy and completeness',
        labs: [
          ['Structured extraction: validation', '/extraction#validation'],
          ['Evals', '/evals'],
          ['Case handling: every claim checked', '/casework'],
        ],
        status: 'run',
      },
      {
        id: '2.2',
        title: 'Identify hallucinations, inconsistencies, and biases in responses',
        labs: [
          ['Claude at work: check an answer (including bias)', '/claude-at-work#check'],
          ['Guardrails: groundedness', '/guardrails'],
          ['Confidence', '/confidence'],
        ],
        status: 'run',
      },
      {
        id: '2.3',
        title: 'Apply fact-checking and validation techniques',
        labs: [
          ['Claude at work: check an answer against its source', '/claude-at-work#check'],
          ['Case handling: a separate verifier', '/casework'],
          ['Document automation: the exact quote behind each field', '/documents'],
        ],
        status: 'run',
      },
      {
        id: '2.4',
        title: 'Determine when human review or additional verification is required',
        labs: [
          ['Claude at work: when review is needed', '/claude-at-work#check'],
          ['Confidence: send unsure cases to a person', '/confidence'],
          ['Aftercare: the nurse queue', '/aftercare'],
        ],
        status: 'run',
      },
      {
        id: '2.5',
        title: 'Edit, adapt, refine, and compare outputs for the intended audience',
        labs: [
          ['Claude at work: rewrite for an audience', '/claude-at-work#audiences'],
          ['Scan explainer: written for the patient', '/scan-explainer'],
        ],
        status: 'run',
      },
      {
        id: '2.6',
        title:
          'Organize and curate information and select appropriate output formats (artifacts, inline, structured data)',
        labs: [
          ['Claude at work: choosing an output format', '/claude-at-work#formats'],
          ['Deck builder', '/decks'],
          ['Site builder', '/site-builder'],
        ],
        status: 'product',
        note: 'Artifacts are a claude.ai feature; the page explains when to use one, and the deck and site builders make the same choice in an app.',
      },
    ],
  },
  {
    n: 3,
    name: 'Product and Model Selection',
    weight: 12,
    tasks: [
      {
        id: '3.1',
        title: 'Select appropriate Claude product features (Projects, research mode, chat, artifacts)',
        labs: [['Claude at work: which feature for which job', '/claude-at-work#features']],
        status: 'product',
        note: 'Projects, Research and Artifacts are practised in claude.ai; the page explains when to use each, with sources.',
      },
      {
        id: '3.2',
        title: 'Differentiate between Claude model types (Haiku, Sonnet, Opus)',
        labs: [
          ['Claude at work: Haiku, Sonnet and Opus', '/claude-at-work#models'],
          ['Routing', '/routing'],
          ['Live Claude', '/live'],
        ],
        status: 'run',
      },
      {
        id: '3.3',
        title: 'Align model selection with task requirements (cost, speed, quality)',
        labs: [
          ['Routing', '/routing'],
          ['Context and cost', '/context'],
          ['Live Claude: effort', '/live'],
        ],
        status: 'run',
      },
      {
        id: '3.4',
        title: 'Understand and manage context limitations and memory (when to restart, summarize, or persist)',
        labs: [
          ['Claude at work: context and memory', '/claude-at-work#context'],
          ['Context engineering', '/context-engineering'],
          ['Claude Code behind the scenes: /clear, /compact and resume', '/claude-code-inside#rewind'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 4,
    name: 'Workflow Integration and Solution Design',
    weight: 16,
    tasks: [
      {
        id: '4.1',
        title: 'Apply Claude to analyze requirements and use cases',
        labs: [
          ['Delivery: from brief to design', '/delivery#brief'],
          ['Delivery: discovery', '/delivery#discovery'],
          ['Agent types', '/agent-types'],
        ],
        status: 'run',
      },
      {
        id: '4.2',
        title: 'Leverage Claude for research, planning, and process optimization',
        labs: [
          ['Harness: a research sub-agent with web search', '/harness'],
          ['ReAct and planning patterns', '/planning-patterns'],
        ],
        status: 'run',
      },
      {
        id: '4.3',
        title: 'Use Claude to support solution design, development, and iteration',
        labs: [
          ['Coding agent', '/coding-agent'],
          ['Site builder', '/site-builder'],
          ['Deck builder', '/decks'],
        ],
        status: 'run',
      },
      {
        id: '4.4',
        title: 'Integrate Claude into existing workflows to augment or redesign them',
        labs: [
          ['Case handling: a complaints process', '/casework'],
          ['Aftercare: follow-up calls', '/aftercare'],
          ['Closed-deal agents', '/deal-close'],
          ['Agent workflows', '/workflows'],
        ],
        status: 'run',
      },
      {
        id: '4.5',
        title: "Communicate Claude's value and limitations to stakeholders",
        labs: [
          ['Claude at work: explaining value and limits', '/claude-at-work#stakeholders'],
          ['Delivery: value pillars', '/delivery#value'],
          ['Evals: accuracy by kind of case', '/evals'],
        ],
        status: 'explained',
      },
    ],
  },
  {
    n: 5,
    name: 'Configuration and Knowledge Management',
    weight: 12,
    tasks: [
      {
        id: '5.1',
        title: 'Configure Claude Projects with instructions and knowledge sources',
        labs: [
          ['Claude at work: setting up a Project', '/claude-at-work#features'],
          ['MedAssist: instructions and knowledge documents', '/medassist'],
        ],
        status: 'product',
        note: 'Projects are configured in claude.ai; the page gives the steps, and MedAssist shows the same idea on Foundry.',
      },
      {
        id: '5.2',
        title: 'Manage uploaded knowledge and connectors (e.g., Google Drive, Gmail)',
        labs: [
          ['Claude at work: connectors and knowledge', '/claude-at-work#features'],
          ['MCP servers', '/mcp'],
        ],
        status: 'product',
        note: 'Connectors are set up in claude.ai; custom connectors are MCP servers, which the MCP lab builds.',
      },
      {
        id: '5.3',
        title: 'Create effective system-level instructions',
        labs: [
          ['Claude at work: prompt templates', '/claude-at-work#task-types'],
          ['Prompting', '/prompting'],
          ['Claude Code setup: CLAUDE.md best practices', '/claude-code#claudemd'],
        ],
        status: 'run',
      },
      {
        id: '5.4',
        title: 'Inform, maintain, and update Claude configurations, knowledge sources, and instructions',
        labs: [
          ['Claude at work: keeping a Project current', '/claude-at-work#features'],
          ['MedAssist: instruction versions', '/medassist'],
        ],
        status: 'explained',
      },
    ],
  },
  {
    n: 6,
    name: 'Governance, Risk, and Responsible Use',
    weight: 15,
    tasks: [
      {
        id: '6.1',
        title: 'Identify appropriate and inappropriate use cases',
        labs: [
          ['Claude at work: is this a good use?', '/claude-at-work#use-case'],
          ['Guardrails: is this a supported use?', '/guardrails#use-cases'],
        ],
        status: 'run',
      },
      {
        id: '6.2',
        title: 'Apply data sensitivity, regulatory, and privacy considerations',
        labs: [
          ['Claude at work: data sensitivity and redaction', '/claude-at-work#use-case'],
          ['Guardrails: personal data', '/guardrails'],
          ['Local model: data that never leaves the machine', '/local-model'],
        ],
        status: 'run',
      },
      {
        id: '6.3',
        title: 'Follow organizational AI policies and governance standards',
        labs: [
          ['Claude at work: responsible use', '/claude-at-work#governance'],
          ['Delivery: compliance', '/delivery#compliance'],
          ['Case handling: audit trail and approval', '/casework'],
        ],
        status: 'explained',
      },
      {
        id: '6.4',
        title: 'Understand the ethical implications of AI usage',
        labs: [
          ['Claude at work: checking for bias', '/claude-at-work#check'],
          ['Claude at work: ethics', '/claude-at-work#governance'],
          ['Delivery: risks and ethics', '/delivery#risks'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 7,
    name: 'Troubleshooting and Optimization',
    weight: 10,
    tasks: [
      {
        id: '7.1',
        title: 'Identify, diagnose, and resolve issues with underperforming prompts or poor outputs',
        labs: [
          ['Claude at work: prompts by task type', '/claude-at-work#task-types'],
          ['Evals: error analysis', '/evals'],
          ['Monitoring and traces', '/observability'],
        ],
        status: 'run',
      },
      {
        id: '7.2',
        title: 'Adjust approach based on feedback and results',
        labs: [
          ['Evals', '/evals'],
          ['Case handling: revise once', '/casework'],
        ],
        status: 'run',
      },
      {
        id: '7.3',
        title: 'Optimize workflows for efficiency and effectiveness',
        labs: [
          ['Context and cost', '/context'],
          ['Routing', '/routing'],
          ['Semantic cache', '/semantic-cache'],
        ],
        status: 'run',
      },
    ],
  },
];

const ASSOCIATE: Exam = {
  id: 'associate',
  name: 'Claude Certified Associate – Foundations',
  code: 'CCAO-F',
  fee: 99,
  questions: 60,
  pageUrl: 'https://anthropic-partners.skilljar.com/claude-certified-associate-foundations-certification',
  item: ['objective', 'objectives'],
  intro: (
    <>
      Every objective in Anthropic’s exam guide, with where the lab shows it. This exam is for people who use Claude in
      claude.ai and the apps, not for developers, so a few objectives are practised in the product itself; the lab’s
      pages show what happens underneath.
    </>
  ),
  audience: (
    <>
      <b>For</b> people who use Claude as a productivity tool and build Claude Projects in operations, marketing,
      project management, education, communications and consulting. No coding or API experience is needed; the exam
      expects you to know when to hand technical work to a Claude Developer or Architect. Checking Claude’s output is
      the largest domain, at 21%.
    </>
  ),
  domains: DOMAINS,
  prepare: (
    <ul>
      <li>
        <b>In claude.ai:</b> set up a Project with instructions and knowledge files, try Research and Artifacts, and
        connect a source such as Google Drive. The guide also names Memory, Skills and Code Execution.
      </li>
      <li>
        <b>Checking output</b>, the largest domain: work through <a href="/evals">Evals</a>,{' '}
        <a href="/confidence">Confidence</a> and the groundedness checks in <a href="/guardrails">Guardrails</a>. The
        guide’s own sample question is about a confident summary with a made-up subsection number.
      </li>
      <li>
        <b>Choosing a model:</b> <a href="/routing">Routing</a> and <a href="/live">Live Claude</a> show the cost, speed
        and quality trade-off on real calls.
      </li>
      <li>
        <b>Responsible use:</b> remove or anonymise personal data before uploading it, as the guide’s sample answer
        does; <a href="/guardrails">Guardrails</a> shows how personal data is found.
      </li>
    </ul>
  ),
};

export default function ClaudeAssociatePage() {
  return (
    <main className="page-claude-associate">
      <ExamMap exam={ASSOCIATE} />
    </main>
  );
}
