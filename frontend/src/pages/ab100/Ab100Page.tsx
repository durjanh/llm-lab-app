import { ExamMap, type Exam, type Link, type Status, type Task } from '../claude-architect/examMap';

/* The exam map for Microsoft's AB-100: Agentic AI Business Solutions Architect. Every skill in the study guide (skills
   measured as of 16 November 2026), with where the lab practises it. Much of the exam is about Microsoft's business
   apps (Copilot Studio, Microsoft 365 Copilot, Dynamics 365, Power Platform), which the lab does not run; those skills
   are marked as practised in the apps, with the lab pages that show the same idea underneath. */

const DEL = '/delivery',
  OPS = '/foundry-operations',
  OBS = '/observability';

let counter = 0;
const t = (group: string, title: string, status: Status, labs: Link[], note?: string): Task => ({
  id: String(++counter),
  group,
  title,
  status,
  labs,
  note,
});
const restart = () => (counter = 0);

const G1 = 'Analyze requirements for AI-powered business solutions',
  G2 = 'Design overall AI strategy for business solutions',
  G3 = 'Evaluate the costs and benefits of an AI-powered business solution',
  G4 = 'Design AI and agents for business solutions',
  G5 = 'Design extensibility of AI solutions',
  G6 = 'Orchestrate configuration for prebuilt agents and apps',
  G7 = 'Analyze, monitor, and tune AI-powered business solutions',
  G8 = 'Manage the testing of AI-powered business solutions',
  G9 = 'Design the ALM process for AI-powered business solutions',
  G10 = 'Design responsible AI, security, governance, risk management, and compliance';

const PLAN: Task[] = [
  t(G1, 'Assess the use of agents in task automation, data analytics, and decision-making', 'run', [
    ['Agent types', '/agent-types'],
    ['Data agent', '/data-agent'],
    ['Delivery: choosing the pattern', `${DEL}#patterns`],
  ]),
  t(G1, 'Review data for grounding, including accuracy, relevance, timeliness, cleanliness, and availability', 'run', [
    ['Search pipeline: ingestion report and index health', '/search-pipeline'],
    ['Embeddings and RAG', '/embeddings'],
    ['Vector database', '/vector-db'],
  ]),
  t(G1, 'Organize business solution data to be available for other AI systems', 'run', [
    ['Data agent: a semantic model as knowledge', '/data-agent'],
    ['MCP servers: data as tools and resources', '/mcp'],
    ['Vector database: collections', '/vector-db'],
  ]),
  t(G2, 'Implement the AI adoption process from the Cloud Adoption Framework for Azure', 'explained', [
    ['Delivery: AI adoption with the Cloud Adoption Framework', `${DEL}#adoption`],
  ]),
  t(G2, 'Design the strategy for building AI and agents in business solutions', 'run', [
    ['Delivery: from brief to design', `${DEL}#brief`],
    ['Delivery: choosing the pattern', `${DEL}#patterns`],
    ['Agent types', '/agent-types'],
  ]),
  t(
    G2,
    'Design a multi-agent solution by using platforms such as Microsoft 365 Copilot, Copilot Studio, and Microsoft Foundry',
    'part',
    [
      ['Research team: a coordinator and specialists', '/research-team'],
      ['Agent workflows (Agent Framework)', '/workflows'],
      ['MedAssist on Foundry', '/medassist'],
    ],
    'Multi-agent design runs here, including on Foundry. Not here: Microsoft 365 Copilot and Copilot Studio.',
  ),
  t(G2, 'Develop the use cases for prebuilt agents in the solution', 'product', [
    ['Delivery: build, buy or extend', `${DEL}#build-buy`],
  ]),
  t(
    G2,
    'Define the solution rules and constraints when building AI components with Copilot Studio, Microsoft Foundry and Microsoft Foundry Tools',
    'part',
    [
      ['MedAssist: rules in code around a Foundry agent', '/medassist'],
      ['Guardrails (Content Safety in Foundry Tools)', '/guardrails'],
      ['Aftercare: rules in code', '/aftercare'],
    ],
    'Foundry and Foundry Tools run here; Copilot Studio does not.',
  ),
  t(G2, 'Determine the use of generative AI and knowledge sources in agents built with Copilot Studio', 'product', [
    ['Embeddings and RAG: knowledge sources underneath', '/embeddings'],
  ]),
  t(G2, 'Determine when to build custom agents or extend Microsoft 365 Copilot', 'product', [
    ['Delivery: build, buy or extend', `${DEL}#build-buy`],
  ]),
  t(G2, 'Determine when custom AI models should be created', 'run', [
    ['Fine-tuning with LoRA', '/lora'],
    ['Tabular foundation models', '/tabular'],
    ['Delivery: build, buy or extend', `${DEL}#build-buy`],
  ]),
  t(
    G2,
    'Provide guidelines for creating a prompt library',
    'part',
    [
      ['Delivery: a prompt library', `${DEL}#prompt-library`],
      ['Claude at work: prompt templates by task type', '/claude-at-work#task-types'],
    ],
    'The templates run; the library guidelines are the lab’s own, as Microsoft Learn has no page on it.',
  ),
  t(G2, 'Develop the use cases for customized small language models for the solution', 'run', [
    ['Local model: an open model on this machine', '/local-model'],
    ['Fine-tuning with LoRA: a small model, before and after', '/lora'],
  ]),
  t(G2, 'Provide prompt engineering guidelines and techniques for AI-powered business solutions', 'run', [
    ['Prompting', '/prompting'],
    ['Claude at work', '/claude-at-work#task-types'],
    ['Evals: few-shot hard cases', '/evals'],
  ]),
  t(G2, 'Include the elements of the Microsoft AI Center of Excellence', 'explained', [
    ['Delivery: an AI Center of Excellence', `${DEL}#coe`],
  ]),
  t(G2, 'Design AI solutions that use multiple Dynamics 365 apps', 'product', [
    ['Closed-deal agents: one event across several systems', '/deal-close'],
  ]),
  t(G3, 'Select ROI criteria for AI-powered business solutions, including the total cost of ownership', 'run', [
    ['Delivery: ROI and total cost of ownership', `${DEL}#roi`],
    ['Context and cost', '/context'],
  ]),
  t(G3, 'Create an ROI analysis for the proposed AI solution for a business process', 'run', [
    ['Delivery: the ROI calculator', `${DEL}#roi`],
    ['Delivery: value pillars', `${DEL}#value`],
  ]),
  t(G3, 'Analyze whether to build, buy, or extend AI components for business solutions', 'explained', [
    ['Delivery: build, buy or extend', `${DEL}#build-buy`],
  ]),
  t(G3, 'Implement a model router to intelligently route requests to the most suitable model', 'run', [
    ['Routing', '/routing'],
  ]),
];

restart();
const DESIGN: Task[] = [
  t(G4, 'Design business terms for Copilot in Dynamics 365 apps for customer experience and service', 'product', []),
  t(G4, 'Design customizations of Copilot in Dynamics 365 apps for customer experience and service', 'product', []),
  t(G4, 'Design connectors for Copilot in Dynamics 365 Sales', 'product', [
    ['MCP servers: a connector underneath', '/mcp'],
  ]),
  t(G4, 'Design agents for integration with Dynamics 365 Contact Center channels', 'product', [
    ['Aftercare: an agent on a phone line (Azure Communication Services)', '/aftercare'],
    ['MedAssist: the practice phone line', '/medassist'],
  ]),
  t(G4, 'Design task agents', 'run', [
    ['Support desk agent', '/support-desk'],
    ['Agents and tools', '/agents'],
    ['Hotel booking', '/hotel'],
  ]),
  t(G4, 'Design autonomous agents', 'run', [
    ['Agent types: autonomous', '/agent-types'],
    ['Coding agent: auto mode', '/coding-agent'],
  ]),
  t(G4, 'Design prompt and response agents', 'run', [
    ['Prompting', '/prompting'],
    ['Agent types', '/agent-types'],
  ]),
  t(G4, 'Propose Microsoft Foundry Tools for a given requirement', 'run', [
    ['Guardrails', '/guardrails'],
    ['Content Understanding', '/content-understanding'],
    ['Translation and speech', '/translation-speech'],
    ['Review analysis (Azure Language)', '/reviews'],
  ]),
  t(G4, 'Propose code-first generative pages and the use of an agent feed for apps', 'product', [
    ['Site builder: pages written by an agent', '/site-builder'],
  ]),
  t(G4, 'Design topics for Copilot Studio, including fallback', 'product', []),
  t(G4, 'Design data processing for AI models and grounding', 'run', [
    ['Search pipeline: ingestion and enrichment', '/search-pipeline'],
    ['Content Understanding', '/content-understanding'],
    ['Vector database: chunking', '/vector-db'],
  ]),
  t(G4, 'Design a business process to include AI components in a Power Apps canvas app', 'product', [
    ['Agent workflows: AI steps inside a process', '/workflows'],
  ]),
  t(
    G4,
    'Apply the Microsoft Power Platform Well-Architected Framework to intelligent application workloads',
    'product',
    [],
  ),
  t(
    G4,
    'Determine when to use standard natural language processing, conversational language understanding, or generative AI orchestration in Copilot Studio',
    'part',
    [
      ['Review analysis: Azure Language against a model', '/reviews'],
      ['Routing', '/routing'],
    ],
    'The trade-off between classic language services and a generative model runs here; Copilot Studio does not.',
  ),
  t(G4, 'Design agents and agent flows with Copilot Studio', 'product', [['Agent workflows', '/workflows']]),
  t(G4, 'Design prompt actions in Copilot Studio', 'product', []),
  t(
    G5,
    'Design AI solutions by using custom models in Microsoft Foundry',
    'part',
    [
      ['Foundry operations: deployments', OPS],
      ['Fine-tuning with LoRA', '/lora'],
    ],
    'Deploying models in Foundry runs here; the custom model is trained on this machine, not in Foundry.',
  ),
  t(G5, 'Design agents in Microsoft 365 Copilot', 'product', []),
  t(G5, 'Design agent extensibility in Copilot Studio', 'product', []),
  t(
    G5,
    'Design agent extensibility with Model Context Protocol in Copilot Studio',
    'part',
    [['MCP servers', '/mcp']],
    'The MCP server side runs here; connecting it in Copilot Studio is done in Copilot Studio.',
  ),
  t(
    G5,
    'Design agents to automate tasks in apps and websites by using Computer Use in Copilot Studio',
    'part',
    [['Agent types: browsing and computer use', '/agent-types']],
    'python/24_browser_agent.py and 25_computer_use_agent.py drive Chrome with Claude; Copilot Studio’s computer use is not here.',
  ),
  t(
    G5,
    'Design agent behaviors in Copilot Studio, including reasoning and voice mode',
    'part',
    [
      ['Reasoning models', '/reasoning-models'],
      ['Aftercare: voice', '/aftercare'],
      ['Tutor', '/tutor'],
    ],
    'Reasoning and voice agents run here; not in Copilot Studio.',
  ),
  t(G5, 'Optimize solution design by using agents in Microsoft 365, including Teams and SharePoint', 'product', []),
  t(G6, 'Orchestrate AI features in Dynamics 365 apps for finance and supply chain', 'product', []),
  t(G6, 'Orchestrate AI features in Dynamics 365 apps for customer experience and service', 'product', []),
  t(G6, 'Propose Microsoft 365 agents for business scenarios', 'product', []),
  t(
    G6,
    'Orchestrate the configuration of Microsoft 365 Copilot for Sales and Microsoft 365 Copilot for Service',
    'product',
    [],
  ),
  t(G6, 'Propose Microsoft Power Platform AI features, including AI hub', 'product', []),
  t(
    G6,
    'Design interoperability of the finance and operations agent chats to use additional knowledge sources',
    'product',
    [],
  ),
  t(
    G6,
    'Recommend the process of adding knowledge sources to in-app help and guidance for Dynamics 365 Finance or Dynamics 365 Supply Chain Management apps',
    'product',
    [],
  ),
];

restart();
const DEPLOY: Task[] = [
  t(G7, 'Recommend the process and tools required for monitoring agents', 'run', [
    ['Monitoring and traces', OBS],
    ['Foundry operations: tracing', OPS],
    ['Delivery: observability at scale', `${DEL}#observability`],
  ]),
  t(
    G7,
    'Analyze backlog and user feedback of AI and agent usage',
    'explained',
    [
      ['Delivery: the life cycle and feedback loops', `${DEL}#lifecycle`],
      ['Evals: error analysis', '/evals'],
    ],
    'Not yet: a feedback backlog collected from a running agent.',
  ),
  t(G7, 'Apply AI-based tools to analyze and identify issues and perform tuning', 'run', [
    ['Adversarial testing: an automated attacker and judge', '/red-team'],
    ['Evals: a model as judge', '/evals'],
    ['Code review passes', '/review-passes'],
  ]),
  t(G7, 'Monitor agent performance and metrics', 'run', [
    ['Monitoring and traces', OBS],
    ['Support desk: first-contact resolution', '/support-desk#evaluate'],
  ]),
  t(G7, 'Interpret telemetry data for performance and model tuning', 'run', [
    ['Monitoring and traces', OBS],
    ['Foundry operations: Azure Monitor', OPS],
    ['Structured extraction: two models compared', '/extraction#compare'],
  ]),
  t(G8, 'Recommend the process and metrics to test agents', 'run', [
    ['Evals', '/evals'],
    ['Support desk: run all customers', '/support-desk#evaluate'],
    ['Aftercare: scripted patients', '/aftercare'],
  ]),
  t(G8, 'Create validation criteria of custom AI models', 'run', [
    ['Fine-tuning with LoRA: before and after', '/lora'],
    ['Tabular foundation models', '/tabular'],
    ['Structured extraction: a labelled set', '/extraction#confidence'],
  ]),
  t(
    G8,
    'Validate effective Copilot prompt best practices',
    'part',
    [
      ['Claude at work: prompt templates', '/claude-at-work#task-types'],
      ['Prompting', '/prompting'],
    ],
    'Prompt practice runs here on Claude; Microsoft Copilot itself is not in the lab.',
  ),
  t(G8, 'Design end-to-end test scenarios of AI solutions that use multiple Dynamics 365 apps', 'product', [
    ['Closed-deal agents: one flow, many steps', '/deal-close'],
  ]),
  t(
    G8,
    'Build the strategy for creating test cases by using Copilot',
    'part',
    [
      ['Coding agent: tests first', '/coding-agent'],
      ['Claude Code setup: test generation in CI', '/claude-code#ci'],
    ],
    'Test generation runs here with Claude; not with GitHub Copilot or Microsoft 365 Copilot.',
  ),
  t(G9, 'Design the ALM process for data used in AI models and agents', 'explained', [
    ['Search pipeline: rebuilding an index', '/search-pipeline'],
    ['Delivery: the life cycle', `${DEL}#lifecycle`],
  ]),
  t(G9, 'Design the ALM process for Copilot Studio agents, connectors, and actions', 'product', []),
  t(
    G9,
    'Design the ALM process for Microsoft Foundry Agents Service',
    'run',
    [
      ['MedAssist: agent versions in Foundry', '/medassist'],
      ['Foundry operations: the pipeline', OPS],
    ],
    'azd provisions the agent’s resources; .github/workflows/infra.yml runs an evaluation gate (examples/foundry-cicd).',
  ),
  t(
    G9,
    'Design the ALM process for custom AI models',
    'part',
    [
      ['Fine-tuning with LoRA: adapters kept per run', '/lora'],
      ['Foundry operations: version policy', OPS],
    ],
    'Not yet: promoting a custom model through test and production.',
  ),
  t(G9, 'Design the ALM process for AI in Dynamics 365 apps for finance and supply chain', 'product', []),
  t(G9, 'Design the ALM process for AI in Dynamics 365 apps for customer experience and service', 'product', []),
  t(G10, 'Design security for agents', 'run', [
    ['Coding agent: sandbox and permissions', '/coding-agent'],
    ['Support desk: the gate and hooks', '/support-desk#gate'],
    ['Adversarial testing', '/red-team'],
  ]),
  t(G10, 'Design governance for agents', 'run', [
    ['Case handling: approval before sending', '/casework'],
    ['Harness', '/harness'],
    ['Claude Code setup: permissions and hooks', '/claude-code#hooks'],
  ]),
  t(G10, 'Design model security', 'run', [
    ['Foundry operations: security posture (keyless, roles, networking)', OPS],
    ['Guardrails', '/guardrails'],
  ]),
  t(G10, 'Analyze solution and AI vulnerabilities and mitigations, including prompt manipulation', 'run', [
    ['Prompt injection', '/injection'],
    ['Adversarial testing', '/red-team'],
  ]),
  t(G10, 'Review solution for adherence to responsible AI principles', 'run', [
    ['Guardrails: is this a supported use?', '/guardrails#use-cases'],
    ['Claude at work: checking for bias', '/claude-at-work#check'],
    ['Delivery: risks and ethics', `${DEL}#risks`],
  ]),
  t(G10, 'Validate data residency and movement compliance', 'explained', [
    ['Delivery: compliance and data residency', `${DEL}#compliance`],
    ['Local model: data that never leaves the machine', '/local-model'],
  ]),
  t(
    G10,
    'Design access controls on grounding data and model tuning',
    'part',
    [
      ['MedAssist: each patient sees only their own record', '/medassist'],
      ['Foundry operations: data-plane roles', OPS],
    ],
    'Not yet: per-user security trimming in a search index.',
  ),
  t(G10, 'Design audit trails for changes to models and data', 'run', [
    ['Case handling: a hash-chained audit trail', '/casework'],
    ['MedAssist: audit rows and agent versions', '/medassist'],
  ]),
];

const PRODUCT = {
  label: 'in Microsoft’s apps',
  means:
    'practise it in Copilot Studio, Microsoft 365 Copilot, Dynamics 365 or Power Platform; linked pages show the idea underneath',
  count:
    'are practised in Microsoft’s business apps (Copilot Studio, Microsoft 365 Copilot, Dynamics 365, Power Platform)',
};

const AB100: Exam = {
  id: 'ab100',
  name: 'AB-100: Agentic AI Business Solutions Architect',
  code: 'AB-100',
  pageUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/agentic-ai-business-solutions-architect/',
  item: ['skill', 'skills'],
  domainWord: ['functional group', 'functional groups'],
  product: PRODUCT,
  intro: (
    <>
      Every skill in Microsoft’s study guide for AB-100, the exam for the Microsoft Certified: Agentic AI Business
      Solutions Architect Expert, with where to practise it in this lab. Much of this exam is about Microsoft’s business
      apps, which the lab does not run; for those skills the map links the pages that show the same idea underneath.
    </>
  ),
  facts: [
    <>
      Pass: <b>700</b> or more
    </>,
    <>
      Skills measured as of <b>16 November 2026</b>
    </>,
    <>Plus one Associate certification from Microsoft’s list</>,
    <>Expert level</>,
  ],
  source: (
    <p className="small muted">
      Source: the{' '}
      <a href="https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ab-100">
        AB-100 study guide
      </a>{' '}
      and the{' '}
      <a href="https://learn.microsoft.com/en-us/credentials/certifications/agentic-ai-business-solutions-architect/">
        certification page
      </a>{' '}
      on Microsoft Learn, read on 13 November 2026. The guide’s new skills list takes effect on 16 November 2026.
      Microsoft lists a practice assessment on AI Skills Navigator; learning paths and courses are not yet available. To
      earn the certification you also need one Associate certification, such as AI-103 (see the{' '}
      <a href="/ai-103">AI-103 exam map</a>), PL-400, AB-620 or one of the Dynamics 365 ones.
    </p>
  ),
  audience: (
    <>
      <p>
        <b>For</b> an accomplished solution architect who designs and delivers AI-driven business solutions: scalable,
        secure and integrated across several Microsoft services. Microsoft lists these competencies and
        responsibilities:
      </p>
      <ul className="small">
        <li>
          Architecting solutions with generative AI and Foundry Tools; designing agentic-first and multi-agent
          orchestrated solutions that are secure, scalable and cross-platform.
        </li>
        <li>
          Knowledge of Dynamics 365, Power Platform, Copilot Studio, Foundry Tools and Foundry Models, and working with
          agents from Copilot Studio, AI prompts and Microsoft Foundry across several language models.
        </li>
        <li>Open standards and protocols, including Agent2Agent (A2A) and the Model Context Protocol (MCP).</li>
        <li>
          Responsible AI and the Microsoft Responsible AI Standard; securing models and data workflows (vulnerabilities,
          data residency, access controls, model tuning, change tracking, audit trails, prompt manipulation).
        </li>
        <li>Monitoring agents and reading telemetry; return-on-investment analysis of an AI solution.</li>
        <li>
          Defining architecture strategy and the roadmap for agentic-first processes, prototyping AI components, an ALM
          strategy and an environment strategy (including third-party AI), and guiding organisations to become
          AI-forward.
        </li>
      </ul>
    </>
  ),
  domains: [
    { n: 1, name: 'Plan AI-powered business solutions', weight: 37.5, weightLabel: '35–40%', tasks: PLAN },
    { n: 2, name: 'Design AI-powered business solutions', weight: 32.5, weightLabel: '30–35%', tasks: DESIGN },
    { n: 3, name: 'Deploy AI-powered business solutions', weight: 22.5, weightLabel: '20–25%', tasks: DEPLOY },
  ],
  prepare: (
    <ul>
      <li>
        <b>Strategy and value</b> (the largest group): <a href={`${DEL}#adoption`}>AI adoption</a>,{' '}
        <a href={`${DEL}#coe`}>the AI Center of Excellence</a>, <a href={`${DEL}#build-buy`}>build, buy or extend</a>{' '}
        and <a href={`${DEL}#roi`}>the ROI calculator</a> on the Delivery page, then{' '}
        <a href={`${DEL}#brief`}>From brief to design</a>.
      </li>
      <li>
        <b>Agents on Azure:</b> <a href="/medassist">MedAssist</a> (a Foundry agent with rules in code),{' '}
        <a href="/research-team">Research team</a> (multi-agent) and <a href="/mcp">MCP servers</a>.
      </li>
      <li>
        <b>The business apps:</b> practise Copilot Studio, Microsoft 365 Copilot, Dynamics 365 Copilot features and
        Power Platform AI features in a trial tenant, using Microsoft’s own documentation; the lab cannot run them.
      </li>
      <li>
        <b>Deploy:</b> <a href={OBS}>Monitoring and traces</a>, <a href="/evals">Evals</a>,{' '}
        <a href={OPS}>Foundry operations</a> (the pipeline and security) and <a href="/red-team">Adversarial testing</a>
        .
      </li>
    </ul>
  ),
};

export default function Ab100Page() {
  return (
    <main className="page-ab100">
      <ExamMap exam={AB100} />
    </main>
  );
}
