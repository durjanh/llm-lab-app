import { ExamMap, type Domain, type Exam } from '../claude-architect/examMap';

/* The exam map for Claude Certified Developer – Foundations: every skill in Anthropic's exam guide, with its weight and
   where the lab lets you practise it. */

const CC = '/claude-code',
  CCI = '/claude-code-inside',
  CODING = '/coding-agent',
  HARNESS = '/harness',
  LIVE = '/live';

const DOMAINS: Domain[] = [
  {
    n: 1,
    name: 'Agents and Workflows',
    weight: 14.7,
    tasks: [
      {
        id: '1.1',
        title: 'Agent Architecture',
        weight: 4.5,
        tested:
          'When a workflow beats an agent and the other way round, manager or supervisor hierarchies, and what subagents add.',
        labs: [
          ['Research team: a coordinator and specialists', '/research-team#coordinator'],
          ['Agent types', '/agent-types'],
          ['Agent workflows', '/workflows'],
          ['Building agents', '/building-agents'],
        ],
        status: 'run',
      },
      {
        id: '1.2',
        title: 'Agent Construction with Claude',
        weight: 5.3,
        tested:
          'The Agent SDK, your own agent loops and harnesses, self-hosted against Anthropic-hosted deployment, and hooks for deterministic actions.',
        labs: [
          ['Coding agent: Agent SDK mode and hooks', '/coding-agent'],
          ['Support desk: hooks', '/support-desk#hooks'],
          ['Harness', '/harness'],
        ],
        status: 'run',
        note: 'Self-hosted: our own loops (harness, support desk) and the Agent SDK. Anthropic-hosted: examples/managed-agents runs a Claude Managed Agent (a paid beta, compile-checked) and its README compares it with Foundry hosted agents.',
      },
      {
        id: '1.3',
        title: 'Agent Patterns and Frameworks',
        weight: 4.9,
        tested:
          'Tool-use loops, sub-agents, memory and context-window management, and frameworks such as Strands, LangGraph and PydanticAI.',
        labs: [
          ['ReAct and planning patterns', '/planning-patterns'],
          ['Research team', '/research-team'],
          ['Context engineering', '/context-engineering'],
        ],
        status: 'run',
        note: 'examples/sdks runs the same five tasks in eleven frameworks, including Strands, LangGraph and PydanticAI, with results in RESULTS.md.',
      },
    ],
  },
  {
    n: 2,
    name: 'Applications and Integration',
    weight: 33.1,
    tasks: [
      {
        id: '2.1',
        title: 'Understanding Requirements',
        weight: 3.4,
        tested:
          'Turning business requirements and the solution architecture into functional and infrastructure requirements.',
        labs: [
          ['Delivery: discovery and requirements', '/delivery#discovery'],
          ['Delivery: from brief to design', '/delivery#brief'],
          ['Architecture', '/architecture'],
        ],
        status: 'run',
      },
      {
        id: '2.2',
        title: 'Systems Life Cycle',
        weight: 2.8,
        tested: 'Managing a system through development, implementation, operation and maintenance.',
        labs: [
          ['Delivery: the life cycle', '/delivery#lifecycle'],
          ['Foundry operations: deployments and the pipeline', '/foundry-operations'],
          ['Monitoring and traces', '/observability'],
        ],
        status: 'explained',
        note: 'infra/ builds and removes every resource with azd; .github/workflows/infra.yml provisions and runs an evaluation gate.',
      },
      {
        id: '2.3',
        title: 'Claude API Mechanics',
        weight: 6.8,
        tested:
          'Messages, tools, streaming, vision, thinking, caching, Claude through other vendors, data access, the Batch API, and real time against batch.',
        labs: [
          ['Live Claude: streaming, effort and caching', '/live'],
          ['Structured extraction: batch against real time', '/extraction#batch'],
          ['Agents and tools', '/agents'],
          ['Reasoning models', '/reasoning-models'],
        ],
        status: 'run',
        note: 'python/15_vision.py covers vision. examples/claude-platforms calls Claude through Amazon Bedrock, Google Vertex AI and Microsoft Foundry; each needs an account on that cloud, so it is compile-checked only.',
      },
      {
        id: '2.4',
        title: 'Software Engineering Foundations',
        weight: 7.4,
        tested:
          'REST APIs, JSON, asynchronous code, version control, the development life cycle, code review, and refactoring small and large.',
        labs: [
          ['Code review passes', '/review-passes'],
          ['Coding agent: the practice project', '/coding-agent'],
          ['Claude Code setup: review in CI', '/claude-code#ci'],
        ],
        status: 'run',
      },
      {
        id: '2.5',
        title: 'Claude Application Design',
        weight: 8.6,
        tested:
          'How Claude reads instructions in each interface (Claude Code, Desktop, claude.ai, the API, the SDKs), content boundaries, schema design, session hygiene and plugins.',
        labs: [
          ['Claude at work: one instruction in different places', '/claude-at-work#surfaces'],
          ['Structured extraction: schema design', '/extraction#schema'],
          ['Claude Code behind the scenes: every request', '/claude-code-inside#request'],
          ['Claude Code setup: plugins', '/claude-code#plugins'],
        ],
        status: 'run',
      },
      {
        id: '2.6',
        title: 'Configuration Management',
        weight: 4.1,
        tested: 'CLAUDE.md, settings.json, pinning model versions, versioning prompts, and plugin dependencies.',
        labs: [
          ['Claude Code setup', CC],
          ['MedAssist: agent versions', '/medassist'],
          ['Foundry operations: version policy', '/foundry-operations'],
        ],
        status: 'run',
        note: 'python/common.py holds every model id and price in one place; MedAssist saves its instructions as numbered agent versions.',
      },
    ],
  },
  {
    n: 3,
    name: 'Claude Code',
    weight: 3.1,
    tasks: [
      {
        id: '3.1',
        title: 'Claude Code Operation',
        weight: 3.1,
        tested:
          'Rules, skills, commands, agents and memory; sessions, slash commands, headless and streaming modes, auto mode; the CLAUDE.md hierarchy, /init and settings.json.',
        labs: [
          ['Claude Code setup', CC],
          ['Claude Code behind the scenes', CCI],
          ['Coding agent: auto mode', CODING],
        ],
        status: 'run',
        note: 'Headless mode has its own section and chapter; --output-format stream-json is the streaming mode.',
      },
    ],
  },
  {
    n: 4,
    name: 'Eval, Testing, and Debugging',
    weight: 2.6,
    tasks: [
      {
        id: '4.1',
        title: 'Debugging and Error Handling',
        weight: 2.6,
        tested:
          'Naming the error type, choosing a recovery, reading traces for failure modes, and telling an integration fault from a model fault.',
        labs: [
          ['Support desk: error types and recovery', '/support-desk#errors'],
          ['Monitoring and traces', '/observability'],
          ['Rate limits: retryable or not', '/resilience'],
          ['Evals: accuracy by kind of case', '/evals'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 5,
    name: 'Model Selection and Optimization',
    weight: 16.8,
    tasks: [
      {
        id: '5.1',
        title: 'LLM Fundamentals',
        weight: 5.2,
        tested:
          'Tokens, context windows, sampling, non-determinism and next-token generation; fast mode, extended and adaptive thinking, effort; zero-, one- and few-shot prompting.',
        labs: [
          ['Tokens', '/tokens'],
          ['Sampling', '/sampling'],
          ['Transformer explainer', '/transformer'],
          ['Reasoning models', '/reasoning-models'],
          ['Live Claude: effort', LIVE],
          ['Prompting', '/prompting'],
        ],
        status: 'run',
      },
      {
        id: '5.2',
        title: 'Technical Fundamentals',
        weight: 6.1,
        tested: 'The engineering around an AI application: SDKs that wrap REST APIs, and websockets.',
        labs: [
          ['Local model: one client, three back ends', '/local-model'],
          ['Live Claude', LIVE],
        ],
        status: 'run',
        note: 'python/local_model.py sends Claude-shaped requests to Claude, Azure OpenAI or a local server; python/chrome_driver.py drives Chrome over a websocket.',
      },
      {
        id: '5.3',
        title: 'Model Selection and Tradeoffs',
        weight: 2.7,
        tested:
          'Opus, Sonnet or Haiku for the task, quality against latency and cost, and behaviour changes between model releases.',
        labs: [
          ['Structured extraction: two models compared', '/extraction#compare'],
          ['Routing', '/routing'],
          ['Live Claude', '/live'],
        ],
        status: 'run',
        note: 'The comparison runs the same labelled set on two models and lists regressions per field: the check to run before moving to a new release.',
      },
      {
        id: '5.4',
        title: 'Cost and Token Management',
        weight: 2.8,
        tested: 'Tracking token use, modelling cost, and prompt caching with cache breakpoints.',
        labs: [
          ['Context and cost', '/context'],
          ['Token counter', '/token-counter'],
          ['Live Claude: caching', LIVE],
          ['Semantic cache', '/semantic-cache'],
        ],
        status: 'run',
        note: 'Every reply in the lab is priced by the spend tracker against python/common.py.',
      },
    ],
  },
  {
    n: 6,
    name: 'Prompt and Context Engineering',
    weight: 11.0,
    tasks: [
      {
        id: '6.1',
        title: 'Context Engineering',
        weight: 3.8,
        tested:
          'Managing the context window, preventing drift and bloat (pruning tool output, compaction), and isolating context with subagents or multi-step workflows.',
        labs: [
          ['Context engineering', '/context-engineering'],
          ['Harness: compaction and trimming', HARNESS],
          ['Claude Code behind the scenes: /compact', `${CCI}#context`],
        ],
        status: 'run',
      },
      {
        id: '6.2',
        title: 'Prompt Engineering',
        weight: 4.6,
        tested:
          'Clear instructions, few-shot examples, system or user placement, output constraints, iteration, and sanitising input.',
        labs: [
          ['Prompting', '/prompting'],
          ['Evals: few-shot hard cases', '/evals'],
          ['Prompt injection: untrusted input', '/injection'],
        ],
        status: 'run',
        note: 'python/03_classify_reviews.py --few-shot measures accuracy with and without examples.',
      },
      {
        id: '6.3',
        title: 'Output Handling',
        weight: 2.6,
        tested: 'Structured output, validating responses, defensive parsing, and scepticism toward confident output.',
        labs: [
          ['Structured extraction: validation and retry', '/extraction#validation'],
          ['Document automation', '/documents'],
          ['Confidence', '/confidence'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 7,
    name: 'Security and Safety',
    weight: 8.1,
    tasks: [
      {
        id: '7.1',
        title: 'AI Application Security',
        weight: 3.2,
        tested:
          'Prompt injection, jailbreaks, untrusted input, data leakage, personal data, and authentication, authorisation, confidentiality and integrity.',
        labs: [
          ['Prompt injection', '/injection'],
          ['Adversarial testing', '/red-team'],
          ['Guardrails: personal data', '/guardrails'],
        ],
        status: 'run',
      },
      {
        id: '7.2',
        title: 'Guardrails and Safe Deployment',
        weight: 2.3,
        tested: 'Content policy, layered guardrails, privacy, identity and access management, and least privilege.',
        labs: [
          ['Guardrails', '/guardrails'],
          ['Adversarial testing: defences', '/red-team'],
          ['Coding agent: the sandbox', CODING],
        ],
        status: 'run',
      },
      {
        id: '7.3',
        title: 'Claude Hooks',
        weight: 1.0,
        tested: 'Hooks that stop destructive actions.',
        labs: [
          ['Claude Code setup: hooks', `${CC}#hooks`],
          ['Coding agent: hooks', CODING],
          ['Claude Code behind the scenes: hooks', `${CCI}#hooks`],
        ],
        status: 'run',
      },
      {
        id: '7.4',
        title: 'Identity, Secrets, and Key Management',
        weight: 1.6,
        tested:
          'Secrets, credentials and API keys from development to production; checking identity and access; monitoring authorised access.',
        labs: [
          ['Foundry operations: security posture', '/foundry-operations'],
          ['Claude Code setup: secrets in .mcp.json', `${CC}#mcp`],
          ['MCP servers', '/mcp'],
        ],
        status: 'run',
        note: 'Every Azure call in the lab is keyless (Entra ID); the Anthropic key is read only in python/settings.py; paid routes check the caller in backend/app/api/deps.py.',
      },
    ],
  },
  {
    n: 8,
    name: 'Tools and MCPs',
    weight: 10.6,
    tasks: [
      {
        id: '8.1',
        title: 'Tool Implementation',
        weight: 4.4,
        tested:
          'Function calling, access to outside systems, tool descriptions, error handling, dispatch in a harness, client against server tools, approval patterns, and building a tool set.',
        labs: [
          ['Support desk: tools, errors and approval', '/support-desk#tools'],
          ['Agents and tools', '/agents'],
          ['Harness: your tools and a server tool', '/harness'],
        ],
        status: 'run',
        note: "python/11_harness_loop.py's web agent uses Anthropic's server-side web_search; the support desk routes an over-limit refund to a person.",
      },
      {
        id: '8.2',
        title: 'MCP Server Development',
        weight: 2.1,
        tested:
          'Writing, deploying and connecting MCP servers: resources, tools and prompts; stdio, sockets, client and server.',
        labs: [['MCP servers', '/mcp']],
        status: 'run',
        note: 'examples/mcp: a server with tests, a client that asks Claude, and the API MCP connector calling a hosted server.',
      },
      {
        id: '8.3',
        title: 'Agentic Customization',
        weight: 4.1,
        tested: 'Choosing between built-in tools, custom tools, Skills and MCP for a given use case.',
        labs: [
          ['Claude Code setup: which one do I need?', CC],
          ['Deck builder: Skills', '/decks'],
          ['MCP servers', '/mcp'],
        ],
        status: 'run',
        note: "python/12_agent_skills.py runs Anthropic's Skills in its container.",
      },
    ],
  },
];

const DEVELOPER: Exam = {
  id: 'developer',
  name: 'Claude Certified Developer – Foundations',
  code: 'CCDV-F',
  fee: 125,
  questions: 53,
  pageUrl: 'https://anthropic-partners.skilljar.com/claude-certified-developer-foundations-certification',
  item: ['skill', 'skills'],
  intro: (
    <>
      Every skill in Anthropic’s exam guide, with its weight and where to practise it in this lab. A third of the exam
      is Applications and Integration, mostly the Claude API and application design; Claude Code is only 3%.
    </>
  ),
  audience: (
    <>
      <b>For</b> engineers who build and ship Claude applications, agents and workflows: typically one to five years of
      software engineering, six months or more with Claude or a similar model, Python or TypeScript, and fluency with
      REST APIs and command-line tools. It is not for prompt-only roles.
    </>
  ),
  domains: DOMAINS,
  prepare: (
    <ul>
      <li>
        The guide asks you to build and run at least one Claude application that uses the API, calls tools, applies
        prompt and context engineering, and has basic security and evaluation. The <a href="/hotel">hotel booking</a>{' '}
        agent (<code>examples/hotel/</code>) has all of these; <a href="/evals">Evals</a> and{' '}
        <a href="/guardrails">Guardrails</a> add the checks.
      </li>
      <li>
        Practise building a custom tool and an MCP server: <a href="/agents">Agents and tools</a>, then{' '}
        <a href="/mcp">MCP servers</a>.
      </li>
      <li>
        Manage tokens and cost on real calls: <a href="/context">Context and cost</a> and{' '}
        <a href="/live">Live Claude</a>.
      </li>
      <li>
        For the agent side, the <a href="/claude-architect">Architect exam map</a> covers the same ground in more depth.
      </li>
    </ul>
  ),
};

export default function ClaudeDeveloperPage() {
  return (
    <main className="page-claude-developer">
      <ExamMap exam={DEVELOPER} />
    </main>
  );
}
