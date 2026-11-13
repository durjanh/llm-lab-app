/* Static teaching content for Claude at work. Every statement about the Claude apps was read on Anthropic's own pages
   (listed in SOURCES, checked 13 November 2026). Plan names and limits change, so the pages are the authority. */

export const CHECKED = '13 November 2026';

export interface Feature {
  name: string;
  job: string;
  how: string;
  example: string;
}

export const FEATURES: Feature[] = [
  {
    name: 'Chat',
    job: 'A one-off question, a draft, a quick analysis.',
    how: 'Start a chat and say what you want. Edit an earlier message to branch the conversation.',
    example: 'Paste an angry customer email and ask for three calm reply options of different lengths.',
  },
  {
    name: 'Projects',
    job: 'Repeated work that always needs the same background.',
    how: 'A project is a workspace with its own chats, instructions and knowledge files. On Team and Enterprise plans you can share it as "Can view" or "Can edit".',
    example:
      'A "Monthly board report" project with the house style as instructions and last quarter’s reports as knowledge.',
  },
  {
    name: 'Artifacts',
    job: 'Something you will keep, edit and share, not just read.',
    how: 'Claude opens self-contained content (typically over about 15 lines) in a window beside the chat. Ask for changes, or export a document as Word, PDF or Markdown and slides as PowerPoint or PDF.',
    example: 'A one-page project status dashboard you refine over a few turns and then share.',
  },
  {
    name: 'Research',
    job: 'A question that needs many sources, not one answer.',
    how: 'Paid plans, with web search on. Claude runs several searches that build on each other. It can also use connected tools such as Gmail or Google Docs. It can use up your limits faster than a normal chat.',
    example: 'Compare how five competitors price a similar service, then check every figure it cites yourself.',
  },
  {
    name: 'Connectors',
    job: 'Work that depends on your own files, mail or calendar.',
    how: 'Connectors link Claude to services such as Google Workspace. Sign-in is usually OAuth. Approve tool requests with care, and turn off tools that write data when you do not need them.',
    example: 'Ask Claude to find this week’s meeting notes in Google Drive and list the open actions.',
  },
  {
    name: 'Memory',
    job: 'Preferences and facts that should carry between chats.',
    how: 'Claude saves topics from chats and you can say "remember this". You can review, edit, pause or reset memory in settings. Each project has its own memory. Incognito chats are not saved.',
    example: '"Remember that our reports use British spelling and a one-page summary first."',
  },
  {
    name: 'Skills',
    job: 'A repeatable way of doing a task, loaded only when needed.',
    how: 'A skill is a folder of instructions, scripts and resources. Anthropic provides skills for Excel, Word, PowerPoint and PDF files, and you can make your own. Skills need code execution and file creation to be on.',
    example: 'A skill that turns raw survey results into your team’s standard summary workbook.',
  },
  {
    name: 'Code execution and file creation',
    job: 'A finished file, or arithmetic you do not want guessed.',
    how: 'Claude works in a sandboxed environment and can make .xlsx, .pptx, .docx and PDF files. Artifacts also need this setting on.',
    example: 'Upload a sales export and ask for a workbook with a pivot of revenue by region and a chart.',
  },
];

export const PROJECT_STEPS: [string, string][] = [
  [
    'Write the instructions',
    'Who the reader is, the tone, the format, what to avoid. Short and specific works better than long and vague.',
  ],
  [
    'Add knowledge',
    'Upload the documents Claude should rely on: style guide, policies, past examples. On paid plans, when knowledge nears the context limit Claude switches to retrieval, which Anthropic says expands capacity by up to 10 times.',
  ],
  [
    'Test it',
    'Run three real requests. If an answer ignores a document, name the document in your question or tighten the instruction.',
  ],
  [
    'Keep it current',
    'Replace outdated files rather than adding new ones beside them, or Claude may use either. Review instructions when the work changes, and tell collaborators with edit rights who owns the project.',
  ],
  [
    'Share deliberately',
    'Give "Can view" to people who only need to chat with it, and "Can edit" to the few who maintain it.',
  ],
];

export const MODELS = [
  {
    id: 'Haiku 5.5',
    api: 'claude-haiku-5-5',
    speed: 'Fastest',
    price: 'from $0.10 / $0.50',
    best: 'High-volume, quick jobs such as sorting, extraction and routing.',
  },
  {
    id: 'Sonnet 5.5',
    api: 'claude-sonnet-5-5',
    speed: 'Fast',
    price: '$2 / $10',
    best: 'The best mix of speed and intelligence. The everyday choice.',
  },
  {
    id: 'Opus 5.5',
    api: 'claude-opus-5-5',
    speed: 'Moderate',
    price: '$4 / $20',
    best: 'Long, multi-step knowledge work where quality matters most.',
  },
];

export const MODEL_TASKS: [string, string, string][] = [
  ['Tag 500 support emails by topic', 'Haiku', 'Simple, repeated and speed-sensitive. Spot-check a sample.'],
  ['Draft a weekly team update from notes', 'Sonnet', 'Routine writing where speed and quality both matter.'],
  [
    'Summarise a 40-page supplier contract for a manager',
    'Sonnet, then review',
    'A good summary is within reach, but a person checks the clauses.',
  ],
  [
    'Compare three policy options across many documents',
    'Opus',
    'Long reasoning across sources. Worth the cost for a decision.',
  ],
  ['Brainstorm 20 event names', 'Haiku or Sonnet', 'Low stakes. Try the cheap one first.'],
];

export const CONTEXT_RULES: [string, string][] = [
  [
    'Start a new chat when',
    'the topic changes, answers start to drift or repeat, or Claude seems to forget early details. Anthropic notes that accuracy and recall can degrade as context grows ("context rot"), so more context is not always better.',
  ],
  [
    'Summarise before you start again when',
    'the earlier work matters. Ask: "Summarise decisions, open questions and constraints in 200 words." Check it, then paste it into the new chat.',
  ],
  [
    'Use Project knowledge when',
    'a document is needed again and again by many chats, such as a style guide or product sheet.',
  ],
  [
    'Use memory when',
    'it is a short preference or fact about you or the project that should carry across chats. Memory is not a place for a whole document, and sensitive items need thought: by default Claude does not save topics such as health, politics or religion.',
  ],
  ['Use an incognito chat when', 'you do not want the chat saved to history or memory.'],
];

export const FORMATS: { name: string; use: string; example: string }[] = [
  {
    name: 'Inline in the chat',
    use: 'A short answer you read once.',
    example: 'Three bullet points on why a launch slipped.',
  },
  {
    name: 'Artifact or file',
    use: 'Something to keep, edit, share or hand on in a standard format.',
    example: 'A one-page briefing as a Word document, or a slide deck.',
  },
  {
    name: 'Table',
    use: 'Comparing items on the same attributes, for a person to read.',
    example: 'Three suppliers by price, lead time and risk.',
  },
  {
    name: 'CSV',
    use: 'Rows you will open in a spreadsheet or load into another tool.',
    example: 'Extracted invoice numbers, dates and totals.',
  },
  {
    name: 'JSON',
    use: 'Another program will read it, so the fields must be exact.',
    example: 'A request to a developer’s tool: {"customer": "...", "priority": "high"}.',
  },
];

export const SURFACES: { place: string; reads: string; note: string }[] = [
  {
    place: 'claude.ai and the mobile apps',
    reads: 'Anthropic’s own system prompt first, then your messages, Project instructions and memory.',
    note: 'Anthropic publishes this system prompt: it gives Claude things like the current date and encourages some behaviours. It says those updates do not apply to the API. It does not say exactly how Project instructions are inserted, so do not rely on a particular position.',
  },
  {
    place: 'Claude Code',
    reads: 'Its own system prompt, then CLAUDE.md files as context.',
    note: 'Anthropic’s documentation says CLAUDE.md is delivered as a user message after the system prompt, not as part of it, and that Claude treats it as context, not enforced configuration. Specific, concise instructions are followed more consistently.',
  },
  {
    place: 'The API',
    reads: 'Only the system prompt and messages the developer sends.',
    note: 'There is no claude.ai system prompt and no Project. If a developer wants the same behaviour, they must write it into the system prompt.',
  },
];

export const SAME_INSTRUCTION = {
  instruction: '"Always answer in British English and keep it under 100 words."',
  rows: [
    ['In a Project on claude.ai', 'Put it in the Project instructions. It applies to chats in that project.'],
    ['In Claude Code', 'Put it in CLAUDE.md. It is guidance Claude reads, not a hard rule.'],
    ['Through the API', 'Put it in the system prompt your code sends. Nothing else will carry it.'],
  ],
};

export const GOOD_USES = [
  'Drafting and editing text a person will review before it goes out.',
  'Summarising your own documents, then checking the summary against them.',
  'Brainstorming options, structuring a plan, preparing questions for a meeting.',
  'Turning a messy spreadsheet or notes into a clean table or checklist.',
];
export const POOR_USES = [
  'A final decision about a person (hiring, firing, credit, health or legal status) with nobody accountable.',
  'Facts you cannot check, sent on without review: figures, citations, clause numbers.',
  'Personal, confidential or regulated data your organisation’s policy does not allow in the tool.',
  'Work that needs the same answer every time at volume. That is a job for a built workflow.',
];
export const DATA_RULES = [
  'Remove or anonymise personal data before you upload. Replace names with roles ("[CLIENT]") and drop contact details and identifiers.',
  'Follow your organisation’s policy on which tools and which data are allowed. If you are unsure, ask before you upload.',
  'Know the rules that apply to your data: data-protection law such as UK GDPR, sector rules, contracts with clients. Compliance is the organisation’s job, not the model’s.',
  'Use the account and plan your organisation provides for work, not a personal one.',
];
export const ESCALATE = [
  [
    'To a Claude Developer',
    'The task repeats at volume, must run without a person pasting things in, or needs an integration or a custom prompt that is tested and versioned.',
  ],
  [
    'To a Claude Architect',
    'It touches several systems, needs access control, has questions about where data lives or which regulation applies, or the failure would be costly.',
  ],
];
export const ETHICS = [
  [
    'Bias',
    'Models can reflect the skew of their training data and of your prompt. Check for loaded wording, stereotypes and missing viewpoints, especially in text about people.',
  ],
  [
    'Fairness',
    'Do not let a draft or a ranking decide who gets an opportunity, a service or a penalty without a person who can explain and reverse it. Test with different groups in mind.',
  ],
  [
    'Transparency',
    'Tell people when AI helped, as your organisation’s policy requires, and keep a note of what a person checked.',
  ],
];
export const STAKEHOLDER = [
  ['Say what it does', 'Saves first-draft time on defined tasks. It does not replace judgement or accountability.'],
  [
    'Show evidence, not claims',
    'Run 20 real examples. Report how many a reviewer accepted unchanged, edited or rejected. Time saved per task, and cost per task from the plan or API price.',
  ],
  [
    'Show failure cases',
    'Bring two real mistakes (an invented citation, a missed exclusion) and the check that caught them.',
  ],
  [
    'State the limits and the controls',
    'Which data is allowed, who reviews, what happens when it is wrong, and when the task goes to a developer.',
  ],
  [
    'Be honest about trade-offs',
    'A bigger model costs more and answers more slowly. A strict review adds time. Say what you chose and why.',
  ],
];

export const SOURCES: [string, string][] = [
  ['What are projects?', 'https://support.claude.com/en/articles/9517075-what-are-projects'],
  [
    'What are artifacts and how do I use them?',
    'https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them',
  ],
  ['Using Research on Claude', 'https://support.claude.com/en/articles/11088861-using-research-on-claude'],
  [
    'Chat search and memory',
    'https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context',
  ],
  [
    'Custom connectors using remote MCP',
    'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
  ],
  ['What are skills?', 'https://support.claude.com/en/articles/12512176-what-are-skills'],
  [
    'Create and edit files with Claude',
    'https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude',
  ],
  ['Models overview (descriptions, prices)', 'https://platform.claude.com/docs/en/models/overview'],
  ['Context windows', 'https://platform.claude.com/docs/en/build-with-claude/context-windows'],
  ['System prompts (claude.ai and mobile apps)', 'https://platform.claude.com/docs/en/release-notes/system-prompts'],
  ['How Claude remembers your project (CLAUDE.md)', 'https://code.claude.com/docs/en/memory'],
];

export const CHECK_SAMPLES: { name: string; answer: string; source: string }[] = [
  {
    name: 'Fabricated section number',
    source:
      'Brightwell Ltd refund policy. Customers may return unused goods within 30 days of delivery for a full refund. Refunds are paid to the original payment method within 10 working days. Opened software is not refundable.',
    answer:
      'Under Section 4.2.1 of the Brightwell refund policy, customers can return unused goods within 30 days of delivery for a full refund. Refunds are paid within 10 working days, and opened software is not refundable.',
  },
  {
    name: 'Biased framing',
    source:
      'Staff survey, Harlow office, 2025. 62% of respondents aged under 30 said they would like more remote days. 58% of respondents aged over 50 said the same. Response rate: 71%.',
    answer:
      'Younger staff clearly want remote work because they are less committed to the office, while older staff are more loyal and traditional. The survey shows 62% of under-30s want more remote days, so management should focus on the needs of younger workers.',
  },
  {
    name: 'Fine',
    source:
      'Northgate Library opening hours: Monday to Friday 9am to 7pm, Saturday 10am to 4pm, closed on Sundays and bank holidays. Study rooms can be booked up to 14 days ahead.',
    answer:
      'Northgate Library is open weekdays from 9am to 7pm and on Saturdays from 10am to 4pm. It is closed on Sundays and bank holidays. You can book a study room up to 14 days in advance.',
  },
];

export const REWRITE_SOURCE =
  'On 3 March our booking system was unavailable for 40 minutes, from 10:05 to 10:45. About 2% of customers who tried to book in that time saw an error. We rolled back a database change, no data was lost, and we are adding a check before such changes go live.';
export const AUDIENCE_PRESETS = ['Executive summary', 'Customer email', 'Technical note', 'Team update', 'Press line'];

export const USE_SAMPLES = [
  {
    task: 'Summarise the exit interview notes for Priya Nair (priya.nair@example.com) and decide whether to rehire her.',
    data: 'Notes from HR including her reasons for leaving and a health absence.',
  },
  {
    task: 'Draft a friendly reminder email for people who have not yet booked their training session.',
    data: 'The list of department names only.',
  },
  {
    task: 'Every night, read new invoices from our finance system and post the totals into the ledger.',
    data: 'Supplier invoices as PDFs.',
  },
];
