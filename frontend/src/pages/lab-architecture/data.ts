/* The whole LLM Lab: every component, what it is used for, where it runs, and which views (model paths and service
   groups) pass through it. The diagram's layout is in diagram.ts. */

export type ViewId = 'claude' | 'gpt' | 'local' | 'agents' | 'azureai' | 'phone' | 'coding';

export interface View {
  id: ViewId;
  name: string;
  /** The path a request takes, in order. */
  path: string;
  /** Pages and scripts that use this path. */
  examples: string;
}

export interface LabPart {
  id: string;
  name: string;
  /** An Azure icon file name (without .svg), or a line icon as "line:<name>". */
  icon: string;
  where: string;
  what: string;
  usedFor: string;
  files: string[];
  uses: ViewId[];
  core?: boolean;
}

const ALL: ViewId[] = ['claude', 'gpt', 'local', 'agents', 'azureai', 'phone', 'coding'];

export const VIEWS: View[] = [
  {
    id: 'claude',
    name: 'Claude',
    path: 'A page or script → the backend’s guards and services → the model client → the Claude API (Messages API), with Anthropic’s server tools, Files, Skills and code execution where a page needs them → the reply, priced by the spend tracker.',
    examples:
      'Messages playground, harness, agent skills, decks, the site builder, the tutor, the hotel agent, token counter (count_tokens).',
  },
  {
    id: 'gpt',
    name: 'GPT',
    path: 'The same request in Claude’s shape → the model client sees a gpt- model → gpt_model.py translates it to Chat Completions → the GPT deployment in Microsoft Foundry → the reply translated back into Claude’s shape.',
    examples:
      'Any page with a model picker (the hotel agent, the coding agent, skills in the sandbox); GPT models are offered last, never as the default.',
  },
  {
    id: 'local',
    name: 'Local and in-browser',
    path: 'The model client sends requests for LLM_LAB_LOCAL_MODEL to Docker Model Runner on this machine (Anthropic-compatible API). Claude-only features are refused with a clear message. Separately, some pages run small models in the browser, and the token counter runs published tokenizers here.',
    examples: 'Every model picker when a local model is set; GPT-2, embedder and reranker pages; the token counter.',
  },
  {
    id: 'agents',
    name: 'Foundry agents',
    path: 'A page → the backend’s gateways → Microsoft Foundry: prompt agents (MedAssist, Aftercare) whose function tools run in our process, Agent Framework agents and workflows, and hosted agents. CI provisions the resources and runs an evaluation gate.',
    examples: 'MedAssist, Aftercare, casework workflows, the Agent Framework pages, Foundry operations.',
  },
  {
    id: 'azureai',
    name: 'Azure AI services',
    path: 'A page → the backend’s gateways → Foundry Tools (Language, Content Safety, Translator, Content Understanding, gpt-image-2), Azure AI Search and Azure Speech, all signed in with Entra ID.',
    examples:
      'The AI-103 labs, review analysis, the search lab, guardrails, translation, image generation, the tutor’s voice.',
  },
  {
    id: 'phone',
    name: 'Phone and texts',
    path: 'A phone rings the lab’s number in Communication Services → Event Grid sends the call event to the backend through a dev tunnel → the backend talks through Call Automation (Speech) and Translator → a Foundry agent and its tools. Texts go out through Communication Services; reminders through a Function and a storage table.',
    examples: 'MedAssist’s phone line and texts, Aftercare’s calls, the hotel agent’s confirmations.',
  },
  {
    id: 'coding',
    name: 'Coding agent and sites',
    path: 'The coding agent runs the Claude Agent SDK (or a GPT deployment) from the backend; its commands run in a sandbox (Docker or the OS sandbox here, Container Apps dynamic sessions in Azure); headless Chrome takes screenshots for the site builder and the browser agents.',
    examples: 'The coding agent, the data agent, the site builder, browser and computer-use agents.',
  },
];

export const PARTS: LabPart[] = [
  // Clients
  {
    id: 'pages',
    name: 'Lab pages',
    icon: 'line:browser',
    where: 'Your browser, served by Vite on :5173 (or by the backend on :8000 after a build).',
    what: 'The React and TypeScript front end: one route per lab, listed in pages/registry.ts. Every backend call goes through ApiClient, which adds the X-LLM-Lab header.',
    usedFor: 'Everything a person does in the lab.',
    files: ['frontend/src/pages/registry.ts', 'frontend/src/services/apiClient.ts'],
    uses: ALL,
  },
  {
    id: 'scripts',
    name: 'Lesson scripts and examples',
    icon: 'line:script',
    where: 'This machine, from the root .venv (each SDK example has its own).',
    what: 'The numbered lessons in python/ and the projects in examples/. They call models through the same client as the backend, from common.make_client().',
    usedFor: 'Learning each technique on its own, outside the pages.',
    files: ['python/', 'examples/', 'python/common.py'],
    uses: ['claude', 'gpt', 'local'],
  },
  {
    id: 'browsermodels',
    name: 'In-browser models',
    icon: 'line:chip',
    where: 'The browser, through transformers.js loaded from jsDelivr.',
    what: 'GPT-2, a sentence embedder and a reranker that run on the page itself. The full-internals GPT-2 is served from models/gpt2-explainer/.',
    usedFor: 'Showing what happens inside a model, with no server and no cost.',
    files: ['frontend/src/lib/gpt2.js', 'frontend/src/lib/embedder.js', 'frontend/src/lib/reranker.js'],
    uses: ['local'],
  },
  {
    id: 'ci',
    name: 'GitHub Actions',
    icon: 'line:pipeline',
    where: 'GitHub, signed in to Azure as a pipeline identity.',
    what: 'Runs azd provision and the Foundry evaluation gate on main.',
    usedFor: 'Keeping the Azure resources in step with Bicep, and stopping a release that fails its evaluation.',
    files: ['.github/workflows/infra.yml', 'examples/foundry-cicd/eval_gate.py', 'infra/pipeline.sh'],
    uses: ['agents'],
  },
  {
    id: 'phones',
    name: 'Phones',
    icon: 'users',
    where: 'A real mobile phone.',
    what: 'The person ringing the lab’s number, or receiving its texts.',
    usedFor: 'MedAssist’s and Aftercare’s phone lines; text confirmations and reminders.',
    files: ['examples/medassist/setup-phone-line.sh'],
    uses: ['phone'],
  },
  // The backend
  {
    id: 'guards',
    name: 'Guards',
    icon: 'line:shield',
    where: 'The backend, as route dependencies.',
    what: 'require_lab_page accepts only a local Host and Origin and the X-LLM-Lab header; require_budget stops paid routes once the spending cap is reached.',
    usedFor: 'Making sure only the lab’s own pages can spend money.',
    files: ['backend/app/api/deps.py'],
    uses: ALL.filter((v) => v !== 'phone'),
  },
  {
    id: 'services',
    name: 'Services and runs',
    icon: 'line:layers',
    where: 'The backend (FastAPI on 127.0.0.1:8000), built once by the container.',
    what: 'One service per area of the lab. Long work runs in a background thread as a Run, which streams events to the page as NDJSON and waits for approvals.',
    usedFor: 'All the lab’s work: each router parses a request, calls a service and shapes the reply.',
    files: ['backend/app/services/', 'backend/app/services/runs.py', 'backend/app/container.py'],
    uses: ALL,
  },
  {
    id: 'spend',
    name: 'Spend tracker',
    icon: 'line:money',
    where: 'The backend.',
    what: 'Prices every reply by the model that answered (prices in python/common.py) and adds it to the run’s total.',
    usedFor: 'The spending cap set with --budget.',
    files: ['backend/app/services/spend.py', 'python/common.py'],
    uses: ['claude', 'gpt', 'agents', 'azureai', 'coding'],
  },
  {
    id: 'data',
    name: 'Local data',
    icon: 'line:database',
    where: 'This machine, in gitignored folders.',
    what: 'SQLite databases (MedAssist, the hotel, the data agent’s warehouse), generated files, sites, audit logs, and every conversation’s transcript.',
    usedFor: 'The state each lab needs, kept out of git.',
    files: ['generated/', 'sites/', 'casework/', 'examples/medassist/data/'],
    uses: ['claude', 'agents', 'phone', 'coding'],
  },
  {
    id: 'client',
    name: 'Model client',
    icon: 'line:loop',
    where: 'The backend and the scripts: python/local_model.py.',
    what: 'LabClient takes a request in Claude’s shape and sends it to Claude, to a GPT deployment through gpt_model.py, or to the local model. A 429 or 529 after retries goes once to the fallback model.',
    usedFor: 'Letting every page offer Claude, GPT and a local model with no page knowing the difference.',
    files: ['python/local_model.py', 'python/gpt_model.py', 'python/common.py'],
    uses: ['claude', 'gpt', 'local'],
    core: true,
  },
  {
    id: 'gateways',
    name: 'Gateways',
    icon: 'line:framework',
    where: 'The backend: backend/app/gateways/.',
    what: 'The only code that touches outside SDKs: Foundry agents, Agent Framework, Foundry Tools, Azure Search, Speech, Language, Communication Services and Chrome. Services depend on their small protocols, so tests swap in fakes.',
    usedFor: 'Every call to Azure, Foundry and the browser.',
    files: ['backend/app/gateways/'],
    uses: ['agents', 'azureai', 'phone', 'coding'],
  },
  {
    id: 'coding',
    name: 'Coding agent',
    icon: 'line:terminal',
    where: 'A subprocess of the backend, from examples/claude-agent-sdk/.venv.',
    what: 'The Claude Agent SDK, or a GPT deployment through to_chat and from_chat, working on a copy of a project.',
    usedFor: 'The coding and analysis pages.',
    files: ['backend/app/services/coding.py', 'examples/claude-agent-sdk/'],
    uses: ['coding', 'claude', 'gpt'],
  },
  // This machine
  {
    id: 'localmodel',
    name: 'Local model',
    icon: 'line:container',
    where: 'This machine, in Docker Model Runner (tools/local-model.sh).',
    what: 'An open model served with an Anthropic-compatible API. Priced at zero. It becomes the default model when LLM_LAB_LOCAL_MODEL is set.',
    usedFor: 'Free, offline runs of any page that does not need Claude-only features.',
    files: ['tools/local-model.sh', 'python/local_model.py'],
    uses: ['local'],
  },
  {
    id: 'tokenizers',
    name: 'Tokenizers',
    icon: 'line:tokens',
    where: 'This machine, with the tokenizers and tiktoken libraries; files cached in generated/tokenizers/.',
    what: 'Published tokenizers for GPT, Llama, Mistral, Qwen, DeepSeek and an estimate for Gemini.',
    usedFor: 'The token counter’s exact pieces for models whose tokenizer is published.',
    files: ['backend/app/gateways/hf_tokenizers.py', 'backend/app/services/token_counter.py'],
    uses: ['local'],
  },
  {
    id: 'chrome',
    name: 'Headless Chrome',
    icon: 'line:globe',
    where: 'This machine, driven over the DevTools protocol.',
    what: 'Screenshots and browsing with an origin allowlist.',
    usedFor: 'Letting the site builder check its pages, and the browser agents act on web pages.',
    files: ['backend/app/gateways/browser.py', 'python/chrome_driver.py'],
    uses: ['coding'],
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    icon: 'line:cube',
    where: 'Docker on this machine (tools/sandbox.sh, 127.0.0.1:8099), or the OS sandbox (sandbox-exec or bubblewrap).',
    what: 'Where the coding agent’s commands, and skills on GPT or the local model, run, away from the backend’s credentials.',
    usedFor: 'Running agent commands safely.',
    files: ['tools/sandbox.sh', 'examples/coding-sandbox/server.py', 'python/sandbox_skills.py'],
    uses: ['coding'],
  },
  // Anthropic
  {
    id: 'claude',
    name: 'Claude API',
    icon: 'line:spark',
    where: 'Anthropic’s cloud.',
    what: 'The Messages API with Claude Haiku 5.5 (the default), Sonnet 5.5 and Opus 5.5, plus server tools (web search, code execution), the Files API, Skills in Anthropic’s container, count_tokens and MCP connectors.',
    usedFor: 'Most of the lab’s pages, and everything that needs a Claude-only feature.',
    files: ['backend/app/gateways/claude.py', 'python/common.py'],
    uses: ['claude', 'coding'],
  },
  // Microsoft Foundry
  {
    id: 'gpt',
    name: 'GPT deployments',
    icon: 'azure-openai',
    where: 'Microsoft Foundry, in the lab’s AI Services account (Global Standard).',
    what: 'gpt-5.4-mini and gpt-4.1-mini, plus the embedding models. Reached keylessly with Entra ID.',
    usedFor: 'The GPT option in every model picker, Foundry agents, and embeddings for search.',
    files: ['python/gpt_model.py', 'backend/app/gateways/azure_openai.py', 'infra/resources.bicep'],
    uses: ['gpt', 'agents', 'coding'],
  },
  {
    id: 'promptagents',
    name: 'Prompt agents',
    icon: 'foundry-agent-service',
    where: 'Microsoft Foundry Agent Service, project llm-lab.',
    what: 'MedAssist and Aftercare: model, instructions and tools saved as versions. Their function tools run in our process.',
    usedFor: 'The MedAssist and Aftercare pages and phone lines.',
    files: ['backend/app/gateways/foundry_agent.py', 'examples/medassist/medassist.py'],
    uses: ['agents', 'phone'],
  },
  {
    id: 'agentframework',
    name: 'Agent Framework',
    icon: 'foundry-application',
    where: 'Our process, on a Foundry project’s model; hosted agents run in Foundry.',
    what: 'Microsoft Agent Framework agents and workflows, and the MedAssist inbox deployed as a hosted agent.',
    usedFor: 'The casework workflow, the Agent Framework pages and the practice inbox.',
    files: ['backend/app/gateways/agent_framework.py', 'backend/app/gateways/agent_workflows.py'],
    uses: ['agents'],
  },
  {
    id: 'foundrytools',
    name: 'Foundry Tools',
    icon: 'ai-foundry',
    where: 'Microsoft Foundry, in the AI Services accounts.',
    what: 'Azure Language, Content Safety, Translator, Content Understanding, gpt-image-2 and read-only Resource Manager calls.',
    usedFor: 'The AI-103 labs, review analysis, guardrails, translation and image generation.',
    files: ['backend/app/gateways/foundry_tools.py', 'backend/app/gateways/azure_language.py', 'python/translator.py'],
    uses: ['azureai', 'phone'],
  },
  // Azure platform
  {
    id: 'search',
    name: 'Azure AI Search',
    icon: 'ai-search',
    where: 'Azure, with keys switched off.',
    what: 'Indexes with keyword, vector and hybrid search and the semantic ranker.',
    usedFor: 'The search lab and RAG examples.',
    files: ['backend/app/gateways/azure_search.py'],
    uses: ['azureai'],
  },
  {
    id: 'speech',
    name: 'Azure Speech',
    icon: 'speech',
    where: 'Azure: a Speech account, with the AI Services account as its fallback.',
    what: 'Speech to text and text to speech, including custom voices.',
    usedFor: 'The tutor’s voice, and listening and speaking on phone calls.',
    files: ['backend/app/gateways/azure_speech.py'],
    uses: ['azureai', 'phone'],
  },
  {
    id: 'acs',
    name: 'Communication Services',
    icon: 'communication-services',
    where: 'Azure.',
    what: 'SMS, the lab’s phone number and Call Automation.',
    usedFor: 'Phone lines, text confirmations and reminders.',
    files: ['backend/app/gateways/phone.py', 'backend/app/gateways/hotel_notify.py', 'examples/medassist/sms.py'],
    uses: ['phone'],
  },
  {
    id: 'eventgrid',
    name: 'Event Grid',
    icon: 'event-grid',
    where: 'Azure, sending to the backend through a dev tunnel.',
    what: 'Delivers incoming-call events to the backend’s webhook.',
    usedFor: 'Answering calls to the lab’s number.',
    files: ['examples/medassist/setup-phone-line.sh'],
    uses: ['phone'],
  },
  {
    id: 'functions',
    name: 'Functions and Storage',
    icon: 'function-apps',
    where: 'Azure Functions on Flex Consumption, with a storage table.',
    what: 'Every 15 minutes, sends the reminder texts that are due.',
    usedFor: 'Reminders the day before an appointment, with no server of ours running.',
    files: ['examples/medassist/reminders/function_app.py', 'infra/modules/medassist-texts.bicep'],
    uses: ['phone'],
  },
  {
    id: 'containerapps',
    name: 'Container Apps',
    icon: 'container-apps',
    where: 'Azure Container Apps (a shared app, or a dynamic-sessions pool).',
    what: 'The coding sandbox in the cloud, when LLM_LAB_SANDBOX=sessions.',
    usedFor: 'Running agent commands in Azure instead of on this machine.',
    files: ['examples/coding-sandbox/setup-app.sh', 'examples/coding-sandbox/setup.sh'],
    uses: ['coding'],
  },
  {
    id: 'entra',
    name: 'Entra ID',
    icon: 'managed-identities',
    where: 'Azure.',
    what: 'az login for us, managed identities for Azure resources, a pipeline identity for CI. Roles are granted in Bicep.',
    usedFor: 'Signing in to every Azure service with no keys (Speech is the one place a key path already exists).',
    files: ['infra/main.bicep', 'python/settings.py'],
    uses: ['agents', 'azureai', 'phone', 'coding', 'gpt'],
  },
];
