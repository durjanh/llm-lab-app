import { ExamMap, type Domain, type Exam, type Exercise, type Link, type Scenario } from './examMap';

/* The exam map for Claude Certified Architect – Foundations: every task statement in Anthropic's exam guide, with where
   the lab lets you practise it. Statuses are honest: "partly" names what is missing. */

const HARNESS = '/harness',
  CODING = '/coding-agent',
  CC = '/claude-code',
  CCI = '/claude-code-inside',
  DOCS = '/documents';

const DOMAINS: Domain[] = [
  {
    n: 1,
    name: 'Agentic Architecture & Orchestration',
    weight: 27,
    tasks: [
      {
        id: '1.1',
        title: 'Design and implement agentic loops for autonomous task execution',
        tested:
          'Continue while stop_reason is "tool_use", stop on "end_turn", and append tool results to the history. Not parsing the text for "done", and not an iteration cap as the main stop.',
        labs: [
          ['Support desk: the agent loop', '/support-desk#loop'],
          ['Harness', '/harness'],
          ['Agents and tools', '/agents'],
        ],
        status: 'run',
        note: 'The support desk loop continues on tool_use and stops on end_turn, and its page names the anti-patterns; python/06_agent_loop.py is the same loop in one file.',
      },
      {
        id: '1.2',
        title: 'Orchestrate multi-agent systems with coordinator-subagent patterns',
        tested:
          'Hub and spoke: the coordinator picks which subagents to call, routes all traffic, and re-delegates when the result has gaps. Subagents start with an empty context.',
        labs: [
          ['Research team: the coordinator', '/research-team#coordinator'],
          ['Harness: sub-agents as tools', '/harness'],
          ['Claude Code behind the scenes: subagents', '/claude-code-inside#subagents'],
        ],
        status: 'run',
        note: 'The research coordinator picks which subagents to call, routes everything, checks coverage and re-delegates targeted searches.',
      },
      {
        id: '1.3',
        title: 'Configure subagent invocation, context passing, and spawning',
        tested:
          'The Task tool ("Task" must be in allowedTools), AgentDefinition, passing earlier findings in the subagent prompt, and several Task calls in one response to run in parallel.',
        labs: [
          ['Research team: delegation and parallel calls', '/research-team#delegation'],
          ['Coding agent: Agent SDK mode (Task, AgentDefinition)', '/coding-agent'],
        ],
        status: 'run',
        note: "The research page shows each subagent's exact prompt with earlier findings passed in full, and parallel delegations against their summed time.",
      },
      {
        id: '1.4',
        title: 'Implement multi-step workflows with enforcement and handoff patterns',
        tested:
          'Prerequisites enforced in code (no refund until the customer is verified) rather than by instruction, and a structured handoff summary for the person who takes over.',
        labs: [
          ['Support desk: the gate in code', '/support-desk#gate'],
          ['Support desk: structured handoff', '/support-desk#escalation'],
          ['Aftercare: identity first', '/aftercare'],
        ],
        status: 'run',
      },
      {
        id: '1.5',
        title: 'Apply Agent SDK hooks for tool call interception and data normalization',
        tested:
          'A pre-tool hook that blocks a call breaking policy and redirects it, and a PostToolUse hook that normalises results before the model reads them.',
        labs: [
          ['Support desk: hooks', '/support-desk#hooks'],
          ['Coding agent: hooks', '/coding-agent'],
          ['Claude Code setup: hooks', '/claude-code#hooks'],
        ],
        status: 'run',
        note: 'A pre-tool hook blocks refunds over $500 and redirects to escalation; a post-tool hook normalises mixed dates and status codes. examples/claude-agent-sdk/support_agent_sdk.py does both with Agent SDK hooks.',
      },
      {
        id: '1.6',
        title: 'Design task decomposition strategies for complex workflows',
        tested:
          'A fixed prompt chain for predictable work, adaptive decomposition for open-ended work, and large reviews split into per-file passes plus a cross-file pass.',
        labs: [
          ['Code review passes: per file, then across files', '/review-passes#passes'],
          ['Research team: decomposition', '/research-team#decomposition'],
          ['ReAct and planning patterns', '/planning-patterns'],
        ],
        status: 'run',
      },
      {
        id: '1.7',
        title: 'Manage session state, resumption, and forking',
        tested:
          '--resume with a named session, fork_session to compare two approaches, and starting fresh with a summary when earlier tool results are stale.',
        labs: [
          ['Code review passes: sessions', '/review-passes#sessions'],
          ['Claude Code behind the scenes: rewind and resume', '/claude-code-inside#rewind'],
        ],
        status: 'run',
        note: 'examples/claude-agent-sdk/sessions_sdk.py captures a session id, resumes it, forks it with fork_session=True and continues the latest.',
      },
    ],
  },
  {
    n: 2,
    name: 'Tool Design & MCP Integration',
    weight: 18,
    tasks: [
      {
        id: '2.1',
        title: 'Design effective tool interfaces with clear descriptions and boundaries',
        tested:
          'Descriptions that tell similar tools apart (inputs, outputs, when to use which), renaming or splitting overlapping tools, and system-prompt keywords that override descriptions.',
        labs: [
          ['Support desk: vague against clear tools', '/support-desk#tools'],
          ['MCP servers', '/mcp'],
        ],
        status: 'run',
        note: 'A six-request selection test records which tool the model calls first with overlapping descriptions and with clear ones.',
      },
      {
        id: '2.2',
        title: 'Implement structured error responses for MCP tools',
        tested:
          'isError, an error category (transient, validation, business, permission), whether to retry, and telling a failed lookup from a lookup that found nothing.',
        labs: [
          ['Support desk: structured errors', '/support-desk#errors'],
          ['MCP servers: isError', '/mcp'],
        ],
        status: 'run',
        note: 'isError with errorCategory and isRetryable: a transient outage retried, a business rule explained, and an empty result kept apart from a failure.',
      },
      {
        id: '2.3',
        title: 'Distribute tools appropriately across agents and configure tool choice',
        tested:
          'Four or five tools per agent, scoped to its role, and tool_choice: "auto", "any", or a forced {"type": "tool", "name": …}.',
        labs: [
          ['Support desk: tool_choice', '/support-desk#tool-choice'],
          ['Structured extraction: tool_choice', '/extraction#tool-choice'],
          ['Research team: scoped tools', '/research-team#scoped-tools'],
        ],
        status: 'run',
      },
      {
        id: '2.4',
        title: 'Integrate MCP servers into Claude Code and agent workflows',
        tested:
          'Project .mcp.json against user ~/.claude.json, ${VAR} expansion for secrets, and MCP resources as a catalogue so the agent explores less.',
        labs: [
          ['MCP servers', '/mcp'],
          ['Claude Code setup: MCP servers', '/claude-code#mcp'],
          ['Claude Code behind the scenes: MCP', '/claude-code-inside#mcp'],
        ],
        status: 'run',
        note: 'examples/mcp/server.py has an engagement://catalogue resource listing everything, tested in test_server.py; dot-mcp.json uses ${MCP_TOKEN}.',
      },
      {
        id: '2.5',
        title: 'Select and apply built-in tools (Read, Write, Edit, Bash, Grep, Glob) effectively',
        tested:
          'Grep for content, Glob for paths, Edit needing unique anchor text with Read and Write as the fallback, and exploring from entry points outwards.',
        labs: [
          ['Coding agent', CODING],
          ['Claude Code behind the scenes: reading and editing', CCI],
        ],
        status: 'run',
        note: 'python/19_coding_agent.py refuses an edit whose old_string is not unique and says to include more lines.',
      },
    ],
  },
  {
    n: 3,
    name: 'Claude Code Configuration & Workflows',
    weight: 20,
    tasks: [
      {
        id: '3.1',
        title: 'Configure CLAUDE.md files with appropriate hierarchy, scoping, and modular organization',
        tested:
          'User, project and directory CLAUDE.md, @import, .claude/rules/ topic files, and /memory to see what is loaded.',
        labs: [
          ['Claude Code setup: CLAUDE.md and rules', `${CC}#claudemd`],
          ['Claude Code behind the scenes: what loads when', `${CCI}#request`],
        ],
        status: 'run',
        note: 'examples/claude-code/CLAUDE.example.md uses an @import. This repository has a root CLAUDE.md and dotnet/CLAUDE.md. The setup page diagnoses instructions left in a user-level file.',
      },
      {
        id: '3.2',
        title: 'Create and configure custom slash commands and skills',
        tested:
          '.claude/commands/ against ~/.claude/commands/, SKILL.md frontmatter (context: fork, allowed-tools, argument-hint), and skills against CLAUDE.md.',
        labs: [
          ["Claude Code setup: the team's or yours", `${CC}#commands`],
          ['Claude Code behind the scenes: skills', `${CCI}#skills`],
        ],
        status: 'run',
        note: 'examples/claude-code/dot-claude: commands/fix-issue.md (argument and allowed-tools), skills/map-codebase (context: fork, agent: Explore), skills/release (argument-hint).',
      },
      {
        id: '3.3',
        title: 'Apply path-specific rules for conditional convention loading',
        tested: '.claude/rules/ files with a paths: glob in the frontmatter, loading only for matching files.',
        labs: [
          ['Claude Code setup: rules for part of the codebase', `${CC}#rules`],
          ['Claude Code behind the scenes', `${CCI}#request`],
        ],
        status: 'run',
        note: 'examples/claude-code/dot-claude/rules: api.md for one folder, testing.md for test files anywhere (**/*.test.tsx).',
      },
      {
        id: '3.4',
        title: 'Determine when to use plan mode vs direct execution',
        tested:
          'Plan mode for multi-file or architectural changes, direct execution for a clear single-file fix, and the Explore subagent for verbose discovery.',
        labs: [
          ['Claude Code setup: plan mode or straight to work', `${CC}#plan`],
          ['Coding agent: plan mode', CODING],
          ['Claude Code behind the scenes: plan mode and Explore', `${CCI}#permissions`],
        ],
        status: 'run',
      },
      {
        id: '3.5',
        title: 'Apply iterative refinement techniques for progressive improvement',
        tested:
          'Input and output examples, tests first then sharing failures, the interview pattern, and all interacting issues in one message.',
        labs: [
          ['Claude Code setup: getting there in steps', '/claude-code#iterate'],
          ['Coding agent: the tests-pass check', '/coding-agent'],
        ],
        status: 'run',
        note: 'Test-driven iteration runs in the coding agent; examples, the interview pattern and one message or several are on the setup page.',
      },
      {
        id: '3.6',
        title: 'Integrate Claude Code into CI/CD pipelines',
        tested:
          'claude -p, --output-format json with --json-schema, CLAUDE.md as context for CI, an independent reviewer, and re-runs that report only new issues.',
        labs: [
          ['Code review passes: the CI re-run', '/review-passes#ci'],
          ['Claude Code setup: Claude Code in CI', '/claude-code#ci'],
          ['Claude Code behind the scenes: headless and CI', '/claude-code-inside#ci'],
        ],
        status: 'run',
        note: 'The review behaviour runs in the lab (schema, re-runs reporting new or still-open issues); examples/claude-code/ci/review.sh is the claude -p pipeline to drop into a repository.',
      },
    ],
  },
  {
    n: 4,
    name: 'Prompt Engineering & Structured Output',
    weight: 20,
    tasks: [
      {
        id: '4.1',
        title: 'Design prompts with explicit criteria to improve precision and reduce false positives',
        tested:
          'Categories to report and to skip instead of "be conservative", and severity levels defined with examples.',
        labs: [
          ['Code review passes: vague against explicit criteria', '/review-passes#criteria'],
          ['Document automation: review', '/documents'],
          ['Evals: the rubric', '/evals'],
        ],
        status: 'run',
      },
      {
        id: '4.2',
        title: 'Apply few-shot prompting to improve output consistency and quality',
        tested:
          'Two to four examples for the ambiguous cases, showing the output format and why one action beats another.',
        labs: [
          ['Structured extraction: few-shot for varied layouts', '/extraction#few-shot'],
          ['Prompting', '/prompting'],
          ['Evals: few-shot hard cases', '/evals'],
        ],
        status: 'run',
      },
      {
        id: '4.3',
        title: 'Enforce structured output using tool use and JSON schemas',
        tested:
          'Extraction as a tool with a schema, tool_choice "any" or forced, nullable fields so nothing is invented, and enums with "other" plus a detail field, or "unclear".',
        labs: [
          ['Structured extraction: schema design', '/extraction#schema'],
          ['Structured extraction: tool_choice', '/extraction#tool-choice'],
        ],
        status: 'run',
        note: 'Extraction as a tool with a JSON schema; a required field makes the model invent a value that the nullable version leaves empty; other with detail, and unclear.',
      },
      {
        id: '4.4',
        title: 'Implement validation, retry, and feedback loops for extraction quality',
        tested:
          'Retrying with the specific error, knowing when a retry cannot help (the fact is not in the document), and calculated against stated totals.',
        labs: [
          ['Structured extraction: validation and retry', '/extraction#validation'],
          ['Closed-deal agents', '/deal-close'],
        ],
        status: 'run',
        note: 'The retry carries the document, the failed extraction and the errors, and stops when the fact is only in an attached contract; calculated_total against stated_total.',
      },
      {
        id: '4.5',
        title: 'Design efficient batch processing strategies',
        tested:
          'Message Batches: half price, up to 24 hours, custom_id, no tool calls mid-request; synchronous calls for checks that block a merge.',
        labs: [
          ['Structured extraction: Message Batches', '/extraction#batch'],
          ['Rate limits: let background work wait', '/resilience'],
        ],
        status: 'run',
        note: 'A real batch with a custom_id per document, polled, matched by custom_id, with only the failures resubmitted.',
      },
      {
        id: '4.6',
        title: 'Design multi-instance and multi-pass review architectures',
        tested:
          'An independent reviewer without the writer’s reasoning, per-file passes plus a cross-file pass, and confidence reported per finding.',
        labs: [
          ['Code review passes: passes', '/review-passes#passes'],
          ['Code review passes: an independent reviewer', '/review-passes#independent'],
          ['Code review passes: confidence', '/review-passes#confidence'],
        ],
        status: 'run',
      },
    ],
  },
  {
    n: 5,
    name: 'Context Management & Reliability',
    weight: 15,
    tasks: [
      {
        id: '5.1',
        title: 'Manage conversation context to preserve critical information across long interactions',
        tested:
          'A "case facts" block kept outside the summary, tool output trimmed to the fields that matter, and key findings first against lost-in-the-middle.',
        labs: [
          ['Support desk: case facts and trimming', '/support-desk#context'],
          ['Context engineering: the notes file', '/context-engineering'],
          ['Data agent: only the rows needed', '/data-agent'],
        ],
        status: 'run',
      },
      {
        id: '5.2',
        title: 'Design effective escalation and ambiguity resolution patterns',
        tested:
          'Escalate when the customer asks for a person, when policy is silent, or when there is no progress; not on sentiment or the model’s own confidence; ask for another identifier when several customers match.',
        labs: [
          ['Support desk: escalation', '/support-desk#escalation'],
          ['Aftercare: escalation decided in code', '/aftercare'],
          ['Routing: self-confidence is a weak signal', '/routing'],
        ],
        status: 'run',
        note: 'Escalates when the customer asks for a person or policy is silent, asks for another identifier when several customers match, and treats frustration alone as no reason.',
      },
      {
        id: '5.3',
        title: 'Implement error propagation strategies across multi-agent systems',
        tested:
          'Subagents recover locally and pass up what failed, what was tried and partial results; access failures told apart from empty results; coverage gaps noted in the report.',
        labs: [
          ['Research team: errors', '/research-team#errors'],
          ['ReAct and planning patterns: the replanner', '/planning-patterns'],
        ],
        status: 'run',
        note: 'Transient failures retry inside the subagent; access failures go up with what was tried and partial results; the report notes the gaps.',
      },
      {
        id: '5.4',
        title: 'Manage context effectively in large codebase exploration',
        tested: 'Scratchpad files, subagents to hold verbose exploration, manifests for crash recovery, and /compact.',
        labs: [
          ['Research team: the manifest and resume', '/research-team#manifest'],
          ['Coding agent: explore and the to-do list', '/coding-agent'],
          ['Claude Code behind the scenes: /compact', '/claude-code-inside#context'],
        ],
        status: 'run',
      },
      {
        id: '5.5',
        title: 'Design human review workflows and confidence calibration',
        tested:
          'Field-level confidence calibrated on labelled data, accuracy by document type and field, stratified sampling, and low confidence routed to people.',
        labs: [
          ['Structured extraction: confidence and review', '/extraction#confidence'],
          ['Confidence', '/confidence'],
          ['Evals: accuracy by kind of case', '/evals'],
        ],
        status: 'run',
        note: 'Field confidence calibrated on a labelled split, a review threshold, accuracy by document type and field, and a stratified spot-check sample.',
      },
      {
        id: '5.6',
        title: 'Preserve information provenance and handle uncertainty in multi-source synthesis',
        tested:
          'Claim-to-source mappings kept through synthesis, conflicting figures kept with their sources, and dates so that old and new are not read as a contradiction.',
        labs: [
          ['Research team: provenance', '/research-team#provenance'],
          ['Case handling: every claim cites its sources', '/casework'],
          ['Document automation: the exact quote', '/documents'],
        ],
        status: 'run',
      },
    ],
  },
];

const SCENARIOS: Scenario[] = [
  {
    name: 'Customer Support Resolution Agent',
    does: 'An Agent SDK agent with MCP tools for customers, orders, refunds and escalation, aiming to resolve most cases first time and know when to hand over.',
    domains: '1, 2, 5',
    labs: [
      ['Support desk agent', '/support-desk'],
      ['Support desk: run all eight customers', '/support-desk#evaluate'],
    ],
    fit: 'Close: the tools, gate, hooks, structured errors and escalation all run, scored for first-contact resolution; examples/claude-agent-sdk/support_agent_sdk.py is the Agent SDK version.',
  },
  {
    name: 'Code Generation with Claude Code',
    does: 'A team using Claude Code with CLAUDE.md, custom commands, and plan mode or direct execution.',
    domains: '3, 5',
    labs: [
      ['Claude Code setup', CC],
      ['Claude Code behind the scenes', CCI],
      ['Coding agent', CODING],
    ],
    fit: 'Close.',
  },
  {
    name: 'Multi-Agent Research System',
    does: 'A coordinator with search, document analysis, synthesis and report subagents, producing cited reports.',
    domains: '1, 2, 5',
    labs: [
      ['Research team', '/research-team'],
      ['Harness: sub-agents as tools', HARNESS],
    ],
    fit: 'Close: a coordinator with four subagents, parallel delegation, structured errors, provenance and a resumable manifest.',
  },
  {
    name: 'Developer Productivity with Claude',
    does: 'An Agent SDK agent that explores codebases with the built-in tools and MCP servers.',
    domains: '2, 3, 1',
    labs: [
      ['Coding agent: Agent SDK mode', CODING],
      ['MCP servers', '/mcp'],
    ],
    fit: 'Close.',
  },
  {
    name: 'Claude Code for Continuous Integration',
    does: 'Claude Code in a pipeline: reviews, generated tests and pull request feedback with few false positives.',
    domains: '3, 4',
    labs: [
      ['Code review passes', '/review-passes'],
      ['Claude Code setup: Claude Code in CI', `${CC}#ci`],
      ['Behind the scenes: headless and CI', `${CCI}#ci`],
    ],
    fit: 'Close: criteria, passes, an independent reviewer and re-runs all run in the lab; the pipeline itself is in examples/claude-code/ci to copy into a repository.',
  },
  {
    name: 'Structured Data Extraction',
    does: 'Extraction from unstructured documents, validated against JSON schemas, handling edge cases for downstream systems.',
    domains: '4, 5',
    labs: [
      ['Structured extraction', '/extraction'],
      ['Document automation', DOCS],
    ],
    fit: 'Close: 24 labelled documents, schemas, tool_choice, validation and retry, batches and calibrated review.',
  },
];

const EXERCISES: Exercise[] = [
  {
    name: '1. A multi-tool agent with escalation logic',
    start: [
      ['Support desk agent', '/support-desk'],
      ['MCP servers', '/mcp'],
    ],
    missing:
      'Nothing: every step runs on the support desk. To build it yourself on the Agent SDK, start from examples/claude-agent-sdk/support_agent_sdk.py.',
  },
  {
    name: '2. Claude Code for a team workflow',
    start: [
      ['Claude Code setup', CC],
      ['MCP servers: .mcp.json', '/mcp'],
    ],
    missing:
      'Copy examples/claude-code/dot-claude into a project (rules, a command, a forked skill, hooks), add the project .mcp.json, then add a personal server with claude mcp add --scope user.',
  },
  {
    name: '3. A structured data extraction pipeline',
    start: [['Structured extraction', '/extraction']],
    missing: 'Nothing: schema, retry, few-shot, a batch with resubmission and confidence routing all run there.',
  },
  {
    name: '4. A multi-agent research pipeline',
    start: [['Research team', '/research-team']],
    missing:
      'Nothing: parallel subagents, provenance, a simulated timeout with partial results and conflicting sources all run there.',
  },
];

const OUT_OF_SCOPE: Link[] = [
  ['Fine-tuning', '/lora'],
  ['Embeddings and vector databases', '/vector-db'],
  ['Vision', '/vision'],
  ['Training and model internals', '/training'],
  ['Preference tuning (RLHF)', '/preference-tuning'],
  ['Rate limits, quotas and pricing', '/resilience'],
  ['Tokenisation', '/tokens'],
  ['Benchmarks and model comparison', '/benchmarks'],
  ['Azure configuration', '/foundry-operations'],
];

const ARCHITECT: Exam = {
  id: 'architect',
  name: 'Claude Certified Architect – Foundations',
  code: 'CCAR-F',
  fee: 125,
  questions: 60,
  extraFacts: ['4 scenarios drawn from 6'],
  pageUrl: 'https://anthropic-partners.skilljar.com/claude-certified-architect-foundations-certification',
  item: ['task statement', 'task statements'],
  intro: (
    <>
      Every task statement in Anthropic’s exam guide, with where to practise it in this lab. The exam tests judgement
      about trade-offs in Claude Code, the Agent SDK, the Claude API and MCP, through scenarios taken from real
      deployments.
    </>
  ),
  audience: (
    <>
      <b>For</b> solution architects who design and ship production applications with Claude, typically with six months
      or more of hands-on work with the Claude API, the Agent SDK, Claude Code and MCP.
    </>
  ),
  domains: DOMAINS,
  scenarios: {
    intro:
      'Each exam shows four of these, chosen at random, and asks a set of questions about each. The closest place to practise each one:',
    list: SCENARIOS,
  },
  exercises: EXERCISES,
  outOfScope: {
    links: OUT_OF_SCOPE,
    also: 'Also out of scope: computer use, streaming, authentication and billing, hosting MCP servers, other cloud providers, prompt caching beyond knowing it exists, and Constitutional AI.',
  },
};

export default function ClaudeArchitectPage() {
  return (
    <main className="page-claude-architect">
      <ExamMap exam={ARCHITECT} />
    </main>
  );
}
