/* The thirteen common types of agent, and where each one is built in this lab. */

export interface Example {
  /** A page in the lab, or a file in the repository. */
  label: string;
  href?: string;
  /** The command that runs it, from the repository root with the virtual environment active. */
  run?: string;
  /** Added with this page. */
  isNew?: boolean;
}

export interface AgentType {
  id: string;
  name: string;
  how: string;
  bestFor: string;
  notFor: string;
  /** What the example in this lab makes visible about the type. */
  shows: string;
  examples: Example[];
}

export const AGENT_TYPES: AgentType[] = [
  {
    id: 'reflex',
    name: 'Simple reflex agent',
    how: 'Reacts to the current input with fixed condition → action rules. No model, no memory, no plan.',
    bestFor: 'Simple, repetitive tasks with clear rules: auto-replies, routing, alerts.',
    notFor: 'Anything that needs context: follow-ups, negation, wording it has not seen.',
    shows:
      'Ten emails through seven keyword rules. Six are handled correctly and four fail: "this is not urgent" fires the urgent rule, a follow-up looks like a new request because nothing is remembered, a reworded question matches nothing, and when two rules match, rule order decides. --compare sends the same inbox to a model, which gets all ten right but is slower and costs money.',
    examples: [{ label: 'python/20_reflex_agent.py', run: 'python python/20_reflex_agent.py --compare', isNew: true }],
  },
  {
    id: 'llm',
    name: 'LLM agent',
    how: 'A language model reads the request and decides what to say or do next.',
    bestFor: 'General assistance where the input is natural language and varies a lot.',
    notFor: 'Safety-critical or strictly deterministic work: answers can vary and can be wrong.',
    shows: 'Plain calls to the model, with streaming, cost and the parameters that change the answer.',
    examples: [
      { label: 'Live Claude', href: '/live' },
      { label: 'Prompting', href: '/prompting' },
      { label: 'python/02_self_consistency.py', run: 'python python/02_self_consistency.py' },
    ],
  },
  {
    id: 'tools',
    name: 'Tool-using agent',
    how: 'The model decides when to call tools (APIs, databases, code); your code runs them and returns the results.',
    bestFor: 'Tasks that need live data or real actions: look up an order, book, update a record.',
    notFor: 'When the tools are unreliable or missing: the agent is only as good as its tools.',
    shows:
      'The tool-use loop step by step: parallel calls, errors returned to the model, an allow-list and approval before an email goes.',
    examples: [
      { label: 'Agents & tools', href: '/agents' },
      { label: 'MCP servers', href: '/mcp' },
      { label: 'python/06_agent_loop.py', run: 'python python/06_agent_loop.py --scenario order' },
      { label: 'examples/support-agent/' },
    ],
  },
  {
    id: 'planning',
    name: 'Planning agent',
    how: 'Breaks a goal into steps first, then carries them out, and plans again when a step fails.',
    bestFor: 'Multi-step tasks with a clear goal, where the plan is worth checking before anything runs.',
    notFor: 'One-step tasks: planning adds a call, time and cost for nothing.',
    shows:
      'A weekend in Edinburgh on a £300 budget. The model writes the plan as structured data; code checks it (known tools, dependencies, budget) and runs the steps in order. The cheapest hotel sells out at booking, and the model replans from what has already run. --plan-only stops before anything runs.',
    examples: [
      { label: 'python/21_planning_agent.py', run: 'python python/21_planning_agent.py --auto-approve', isNew: true },
      { label: 'Plan, approve, run (workflow)', href: '/workflows' },
      { label: 'Coding agent plan mode', href: '/coding' },
    ],
  },
  {
    id: 'memory',
    name: 'Memory agent',
    how: 'Keeps notes that outlast one conversation, reads them at the start of the next, and corrects them when things change.',
    bestFor: 'Personal assistants and ongoing work, where repeating yourself every session is the problem.',
    notFor: 'One-off or stateless tasks. Remembering is a privacy risk, and the notes can fill with junk.',
    shows:
      "A memory tool with the files kept on this machine, on Claude (its own memory tool), GPT or the local model (the same commands as a JSON-schema tool). Three separate conversations: preferences are saved, recalled in a fresh conversation, then corrected in place rather than duplicated. The user also pastes a card number and a colleague's health detail; the model usually leaves them out, and with --careless, which tells it to store everything, the storage code refuses them. The run ends by counting what was stored and flagging any fact stored twice.",
    examples: [
      { label: 'python/22_memory_agent.py', run: 'python python/22_memory_agent.py --all', isNew: true },
      { label: 'Context engineering', href: '/context-engineering' },
    ],
  },
  {
    id: 'multi',
    name: 'Multi-agent system',
    how: 'Several agents with set roles work on one task: in turn, in parallel, or in conversation.',
    bestFor: 'Workflows that need different skills or viewpoints, such as researcher, writer and editor.',
    notFor: 'Small or simple tasks: more agents means more calls, more cost and more to coordinate.',
    shows:
      'Sequential, concurrent, handoff, group chat and Magentic patterns, run live or replayed; the same multi-agent task in eight SDKs.',
    examples: [
      { label: 'Agent workflows', href: '/workflows' },
      { label: 'examples/sdks/*/05_multi_agent.py', run: 'python examples/sdks/run_all.py' },
      { label: 'Case handling on Azure', href: '/casework' },
    ],
  },
  {
    id: 'hierarchical',
    name: 'Hierarchical agent',
    how: 'A manager agent splits the work and delegates parts to sub-agents, each starting with a clean context.',
    bestFor: 'Large goals with a clear structure, where sub-tasks would fill one agent’s context.',
    notFor: 'When delegation is not needed: every sub-agent costs a separate conversation.',
    shows:
      'A harness whose tools include three sub-agents, each starting with an empty context; the orchestrator-and-workers workflow; subagents in Claude Code.',
    examples: [
      { label: 'python/11_harness_loop.py', run: 'python python/11_harness_loop.py --scenario team' },
      { label: 'Orchestrator and workers', href: '/workflows' },
      { label: 'Claude Code subagents', href: '/claude-code' },
    ],
  },
  {
    id: 'self-improving',
    name: 'Self-improving agent',
    how: 'Learns from feedback on its own results and carries what it learned into later work.',
    bestFor: 'Repeated, checkable tasks that evolve, where mistakes leave a signal to learn from.',
    notFor: 'Tasks that must stay consistent: lessons can drift, so every change needs a check.',
    shows:
      'Expense lines formatted to a house style the agent is never told directly. A checker reports what failed, the agent writes lessons, and a lesson is kept only if it raises the score on separate validation items, so a planted bad lesson and lessons that change nothing are both rejected. Kept lessons are saved, so the next run starts from them.',
    examples: [
      { label: 'python/23_self_improving_agent.py', run: 'python python/23_self_improving_agent.py', isNew: true },
      { label: 'Maker-checker loop (within one run)', href: '/workflows' },
      { label: 'Evals', href: '/evals' },
    ],
  },
  {
    id: 'rag',
    name: 'RAG agent',
    how: 'Retrieves relevant documents before answering, and cites them.',
    bestFor: 'Current or domain-specific knowledge the model was not trained on.',
    notFor: 'When the model already knows enough: retrieval adds time, and answers are only as good as what is found.',
    shows: 'Embeddings, keyword and hybrid search, reranking, citations, and RAG against CAG and a knowledge graph.',
    examples: [
      { label: 'Embeddings & RAG', href: '/embeddings' },
      { label: 'Search ingestion and relevance', href: '/searchlab' },
      { label: 'python/05_rag.py', run: 'python python/05_rag.py "How much annual leave do I get?" --retrieve-only' },
      { label: 'python/10_rag_vs_cag_vs_kag.py' },
    ],
  },
  {
    id: 'code',
    name: 'Code agent',
    how: 'Reads, writes, runs and fixes code by itself until the tests pass.',
    bestFor: 'Software development and automation where tests tell it when it is done.',
    notFor: 'Production systems without review. It can ship bugs, so it needs a sandbox.',
    shows:
      'A harness built like Claude Code: file tools that refuse blind edits, bash behind rules and an OS sandbox, checkpoints, and a hook that sends it back until the tests pass.',
    examples: [
      { label: 'Coding agent', href: '/coding' },
      { label: 'python/19_coding_agent.py', run: 'python python/19_coding_agent.py --task fix' },
      { label: 'Site builder', href: '/site-builder' },
    ],
  },
  {
    id: 'browsing',
    name: 'Web browsing agent',
    how: 'Navigates sites, reads pages, fills in forms and clicks, in a real browser.',
    bestFor: 'Research, data collection and monitoring on sites with no API.',
    notFor: 'Sensitive or private data. It is slow, and any page can carry instructions aimed at it.',
    shows:
      "Claude's browser toolset driving headless Chrome over three invented shops: a category link, a search form and a sale price. It records prices in a form, which is checked in code. One page hides an instruction to report a shop as out of stock and visit another site; an allowlist in the browser blocks anything off the list.",
    examples: [
      { label: 'python/24_browser_agent.py', run: 'python python/24_browser_agent.py', isNew: true },
      { label: 'Web search sub-agent', run: 'python python/11_harness_loop.py --scenario web' },
    ],
  },
  {
    id: 'computer',
    name: 'Computer use agent',
    how: 'Sees the screen as screenshots and uses the mouse and keyboard, like a person.',
    bestFor: 'Desktop software with no API: legacy apps, spreadsheets, internal tools.',
    notFor:
      'High-risk systems or sensitive data: it is the slowest kind, makes more mistakes and sees everything on screen.',
    shows:
      "Claude's computer toolset on a pretend desktop. It opens a spreadsheet, types the totals and saves, from pixels alone. A notification and an email ask it to send the file to an outside address. The saved sheet is graded, and the run counts the screenshots and actions it took.",
    examples: [
      { label: 'python/25_computer_use_agent.py', run: 'python python/25_computer_use_agent.py', isNew: true },
    ],
  },
  {
    id: 'autonomous',
    name: 'Autonomous agent',
    how: 'Sets its own steps and runs a long task to the end without being prompted at each step.',
    bestFor: 'Long-running, open-ended goals: end-to-end research, fixing a project.',
    notFor: 'When a person must stay in the loop. It is hard to steer and can go off track, so it needs limits.',
    shows:
      'An agent that works until the tests really pass, with a todo list, a turn limit and a spending cap; switch harness features off to see what breaks.',
    examples: [
      { label: 'Harness engineering', href: '/harness' },
      { label: 'python/09_autonomous_agent.py', run: 'python python/09_autonomous_agent.py' },
      { label: 'examples/agents/research_agent.py' },
    ],
  },
];
