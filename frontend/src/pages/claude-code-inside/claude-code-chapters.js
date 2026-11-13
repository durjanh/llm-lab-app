/* Chapters for claude-code-inside.html. Facts were checked against code.claude.com/docs on 15 October 2026.
 * Token counts are illustrative: typical sizes, not measurements.
 *
 * A step: t title, d text (HTML), why, extra (HTML), tags [[class, text]], term [[type, text]],
 * pk [[from, to, label, kind]] packets, on [nodes], add (blocks before the request), call (true or a count),
 * resp (blocks after the request), del [ids], set {id: props}, subAdd, subClear, gates {at, verdict, label}. */
const B = (id, k, label, tok, note) => ({ id, k, label, tok, note });
const U = (id, text, tok, note) => B(id, 'msg', 'You: ' + text, tok, note);
const C = (id, text, tok, note) => B(id, 'msg', 'Claude: ' + text, tok, note);
const T = (id, text, tok, note) => B(id, 'tool', text, tok, note);
const SYS = B('sys', 'sys', 'System prompt', 3000, "Claude Code's own instructions");
const TOOLS = B('tools', 'sys', 'Built-in tool definitions', 12000, 'Read, Edit, Write, Bash, Agent, Skill and more');
const ENV = B('env', 'sys', 'Environment', 300, 'working directory, platform, date, git status');
const MEM = B('mem', 'mem', 'CLAUDE.md files', 1500, 'read at start-up, sent with every request');
const SKL = B('skills', 'skill', 'Skill list', 600, 'name and description of each skill');
const MCPD = B('mcpd', 'mcp', 'MCP tool names', 300, 'names only until needed (tool search)');
const ASK_EDIT = (f) => `Do you want to ${f}?\n❯ 1. Yes\n  2. Yes, allow all edits during this session\n  3. No, and tell Claude what to do differently`;
const go = (id, text) => `<a href="#${id}" data-goto="${id}">${text}</a>`;

const CHAPTERS = [
  // ------------------------------------------------------------------ 1
  {
    id: 'init', short: '/init', title: '/init: give Claude a memory of the project',
    sub: 'What happens when you run /init in a repository for the first time',
    nodes: ['you', 'cc', 'api', 'files'],
    steps: [
      {
        t: 'Meet the parts, then run /init',
        term: [['sh', 'cd payments-api'], ['sh', 'claude'], ['p', '/init']],
        pk: [['you', 'cc', '/init', 'you']],
        add: [SYS, TOOLS, ENV, U('u1', '/init, expanded into instructions to study the codebase', 700, 'Claude Code supplies this text, not you')],
        d: `<b>You</b> type in the terminal. <b>Claude Code</b> is a program on your machine: it keeps the conversation, runs tools and calls the model. <b>Claude</b>, the model, runs at Anthropic and only sees what Claude Code sends it. <b>Files &amp; shell</b> are your project. <code>/init</code> is a built-in command: Claude Code replaces it with instructions to study the codebase and write a CLAUDE.md with the build commands, test instructions and conventions it finds.`,
        why: `There is no CLAUDE.md yet, so the context below holds only Claude Code's own instructions, the tool definitions, facts about your environment and the /init instructions.`
      },
      {
        t: 'Request 1: Claude starts exploring', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', '3 tool calls', 'resp']],
        resp: [T('a1', 'Claude: find, Read, Read, in one reply', 150)],
        term: [['say', "I'll analyze this codebase and create a CLAUDE.md file."], ['tool', 'Bash(find . -type f -not -path "./node_modules/*")'], ['tool', 'Read(package.json)'], ['tool', 'Read(README.md)']],
        tags: [['', 'stop_reason: tool_use']],
        d: `The model cannot see your files. It replies with requests to use tools, here three at once because they do not depend on each other, and stops. Which files it looks at is the model's choice and depends on the project. There is no fixed list.`
      },
      {
        t: 'Claude Code runs the tools on your machine',
        pk: [['cc', 'files', 'find + 2 Reads', 'tool'], ['files', 'cc', 'results', 'file']],
        add: [T('r1', 'Results: file list, package.json, README.md', 7400)],
        term: [['out', 'Found 86 files'], ['out', 'Read 48 lines'], ['out', 'Read 120 lines']],
        d: `Reading and searching inside your project does not need your approval. The results are added to the conversation, ready to go out with the next request.`
      },
      {
        t: 'Requests 2 to 6: more rounds of exploring', call: 5,
        pk: [['cc', 'api', 'requests 2–6', 'req'], ['api', 'cc', 'more tool calls', 'resp'], ['cc', 'files', 'reads, searches', 'tool'], ['files', 'cc', 'results', 'file']],
        resp: [T('explore', '5 more rounds: 14 files read, 3 searches', 26000, "configs, test setup, source files, other tools' rules")],
        term: [['tool', 'Read(tsconfig.json)'], ['tool', 'Read(jest.config.ts)'], ['tool', 'Bash(grep -rn "export class" src/)'], ['tool', 'Read(.cursorrules)'], ['sys', '… 10 more tool calls']],
        d: `Each round is a full request that carries everything so far. If the repository has instructions for other AI tools, such as <code>.cursorrules</code>, <code>.cursor/rules/</code> or <code>.github/copilot-instructions.md</code>, /init brings what they say into the new file.`
      },
      {
        t: 'Claude writes CLAUDE.md, and asks you first', call: true,
        pk: [['cc', 'api', 'request 7', 'req'], ['api', 'cc', 'tool_use: Write', 'resp'], ['cc', 'you', 'create CLAUDE.md?', 'you']],
        resp: [T('a5', 'Claude: Write CLAUDE.md, 58 lines', 1300)],
        term: [['tool', 'Write(CLAUDE.md)'], ['ask', ASK_EDIT('create CLAUDE.md')]],
        d: `Writing a file changes your project, so Claude Code stops and asks. This is the kind of draft it writes:`,
        extra: `<pre class="code wrap"><code># payments-api

## Commands
- \`npm run dev\`: start the API on port 3000
- \`npm test\`: all tests. \`npm test -- refunds\` runs one file
- \`npm run lint\`: ESLint and Prettier; must pass before committing

## Architecture
- \`src/routes/\`: thin HTTP handlers. Business logic lives in \`src/services/\`
- \`src/db/\`: Prisma schema and migrations

## Conventions
- TypeScript strict mode, no \`any\`
- Money is integer pence, never floats
- Throw \`AppError\` from \`src/lib/errors.ts\`</code></pre>`
      },
      {
        t: 'You approve, and the file is written',
        pk: [['you', 'cc', '1. Yes', 'you'], ['cc', 'files', 'write CLAUDE.md', 'tool'], ['files', 'cc', 'done', 'file']],
        add: [T('r5', 'Result: CLAUDE.md written', 60)],
        term: [['out', 'Wrote 58 lines to CLAUDE.md']],
        d: `CLAUDE.md is ordinary Markdown in your repository. Nothing about it is special to git or to the model. Claude Code simply knows where to look for it.`
      },
      {
        t: 'Done. From the next session, it is always loaded', call: true,
        pk: [['cc', 'api', 'request 8', 'req'], ['api', 'cc', 'answer, end_turn', 'resp'], ['cc', 'you', 'answer', 'you']],
        resp: [C('a6', '"Created CLAUDE.md with the commands, architecture and conventions."', 90)],
        term: [['say', 'Created CLAUDE.md with the build and test commands, an overview of the architecture and the conventions I found. Review it, then commit it so the whole team gets it.']],
        tags: [['good', 'stop_reason: end_turn']],
        d: `Eight requests to the model produced one file. CLAUDE.md is read when a session starts, so from the next session, or after <code>/clear</code> or <code>/compact</code>, it goes out with every request. Chapter 3 shows exactly where. Run /init again later and it suggests improvements instead of overwriting your file.`,
        why: `Review it like code. Cut what Claude would work out anyway. Add what it cannot discover, such as why things are the way they are and the mistakes to avoid. Then commit it.`,
        extra: `<div class="mini"><b>Interactive /init</b>Set <code>CLAUDE_CODE_NEW_INIT=1</code> before running /init and it asks which pieces to set up (CLAUDE.md, skills, hooks), explores with a subagent, asks you follow-up questions and shows a proposal before writing anything.</div>`
      }
    ],
    after: `<div class="takeaways"><h3>Remember</h3><ul>
      <li><b>/init is a prompt, not magic.</b> It runs the same agent loop as everything else: explore with tools, then write a file.</li>
      <li><b>Run it once per repository, then edit by hand.</b> Run it again to get suggested improvements; it does not overwrite.</li>
      <li><b>Keep the result short.</b> Everything in CLAUDE.md is sent with every request in every session, as the next two chapters show.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 2
  {
    id: 'loop', short: 'Agent loop', title: 'The agent loop',
    sub: 'One request from you becomes several calls to the model',
    nodes: ['you', 'cc', 'api', 'files'],
    steps: [
      {
        t: 'You ask for something',
        term: [['sh', 'claude'], ['p', 'Add a --verbose flag to the CLI, with a test']],
        pk: [['you', 'cc', 'your prompt', 'you']],
        add: [SYS, TOOLS, ENV, MEM, U('u1', '"Add a --verbose flag to the CLI, with a test"', 30)],
        d: `Before your words go anywhere, Claude Code puts them together with everything the model needs: its own instructions, the tool definitions, facts about your environment and your CLAUDE.md.`,
        why: `Claude Code is the harness and the model is the brain it calls. Everything in this talk is about what the harness puts in front of the model, and what it does with the replies.`
      },
      {
        t: 'Request 1: everything goes to the model', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'tool_use: Read', 'resp']],
        resp: [T('a1', 'Claude: Read src/cli.ts', 80)],
        term: [['say', "I'll look at how the CLI parses its options first."], ['tool', 'Read(src/cli.ts)']],
        tags: [['', 'stop_reason: tool_use']],
        d: `The API keeps no memory between calls, so each request carries everything. The model cannot touch your machine. It replies with a request to use a tool, and stops.`
      },
      {
        t: 'Claude Code runs the tool',
        pk: [['cc', 'files', 'read src/cli.ts', 'tool'], ['files', 'cc', '212 lines', 'file']],
        add: [T('r1', 'Result: src/cli.ts, 212 lines', 2600)],
        term: [['out', 'Read 212 lines']],
        d: `Claude Code checks the permission rules, runs the tool locally and adds the result to the conversation.`
      },
      {
        t: 'Request 2: the whole conversation again', call: true,
        pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'tool_use: Edit', 'resp'], ['cc', 'you', 'allow this edit?', 'you']],
        resp: [T('a2', 'Claude: Edit src/cli.ts', 450)],
        term: [['tool', 'Update(src/cli.ts)'], ['ask', ASK_EDIT('make this edit to cli.ts')]],
        d: `Everything is sent again, now with the tool call and its result. The unchanged start comes from the prompt cache, which is faster and, on the API, costs a tenth of the normal input price. This time the model wants to change a file, so Claude Code asks you first.`,
        why: `The permission check happens in Claude Code, not in the model, so the model cannot skip it.`
      },
      {
        t: 'You approve, and the file changes',
        pk: [['you', 'cc', '1. Yes', 'you'], ['cc', 'files', 'write src/cli.ts', 'tool'], ['files', 'cc', 'done', 'file']],
        add: [T('r2', 'Result: edit applied', 100)],
        term: [['out', 'Updated src/cli.ts with 14 additions and 2 removals']],
        d: `Before changing the file, Claude Code keeps a snapshot of it, so you can rewind later (${go('rewind', 'chapter 11')}).`
      },
      {
        t: 'Request 3: Claude runs the tests', call: true,
        pk: [['cc', 'api', 'request 3', 'req'], ['api', 'cc', 'tool_use: Bash', 'resp'], ['cc', 'files', 'npm test', 'tool'], ['files', 'cc', '43 passed', 'file']],
        resp: [T('a3', 'Claude: Bash npm test', 60), T('r3', 'Result: 43 passed', 350)],
        term: [['tool', 'Bash(npm test)'], ['out', '43 passed (1.9s)']],
        d: `Running the tests is how Claude checks its own work. Whether it asks before running a command depends on your permission rules and mode (${go('permissions', 'chapter 12')}).`
      },
      {
        t: 'Request 4: the answer, and the loop ends', call: true,
        pk: [['cc', 'api', 'request 4', 'req'], ['api', 'cc', 'text, end_turn', 'resp'], ['cc', 'you', 'answer', 'you']],
        resp: [C('a4', '"Added --verbose and a test. 43 tests pass."', 60)],
        term: [['say', 'Added a --verbose flag in src/cli.ts and a test in tests/cli.test.ts. All 43 tests pass.']],
        tags: [['good', 'stop_reason: end_turn']],
        d: `When the model replies without asking for a tool, the loop stops and you see the answer. Your one request became four API calls. Big tasks take hundreds.`,
        why: `Everything else plugs into this loop. CLAUDE.md and skills change what is sent. Hooks and permissions sit between the model and your machine. MCP adds tools. Subagents run loops of their own.`
      }
    ],
    after: `<div class="takeaways"><h3>Remember</h3><ul>
      <li><b>The model only writes text and tool requests.</b> Claude Code does everything on your machine.</li>
      <li><b>Every request resends the whole conversation.</b> The prompt cache makes the repeated part cheap and fast, as long as the start of the request stays the same.</li>
      <li><b>Give Claude a way to check its work</b>, such as tests, a linter or a script. It is the biggest single improvement to results.</li>
      <li>The <a href="/agents">Agents &amp; tools lab</a> shows the raw API requests for this loop.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 3
  {
    id: 'request', short: 'Every request & CLAUDE.md', title: 'Every request: what is actually sent',
    sub: 'Where CLAUDE.md goes, and why it is sent again on every call',
    nodes: ['you', 'cc', 'api', 'files'],
    steps: [
      {
        t: 'Start-up: Claude Code gathers context before you type',
        term: [['sh', 'claude'], ['sys', '(reading memory files, skills and settings)']],
        pk: [['files', 'cc', 'CLAUDE.md files', 'file'], ['files', 'cc', 'skills, settings, memory', 'file']],
        add: [SYS, TOOLS, ENV, B('m-user', 'mem', '~/.claude/CLAUDE.md', 250, 'your preferences, every project'), B('m-proj', 'mem', './CLAUDE.md', 1300, 'the team file, committed to git'), B('m-imp', 'mem', '@docs/testing.md', 600, 'imported by ./CLAUDE.md'), B('m-auto', 'mem', 'Auto memory: MEMORY.md', 400, 'notes Claude saved itself'), SKL, MCPD],
        d: `Before you type anything, Claude Code reads the memory files from disk, from the broadest to the most specific. CLAUDE.md files in the working folder and every folder above it are loaded, from the root down. They all add up; none replaces another.`,
        extra: `<div class="table-wrap"><table class="t"><thead><tr><th>Loaded in this order</th><th>File</th></tr></thead><tbody>
          <tr><td>1. Organisation policy</td><td><code>/Library/Application Support/ClaudeCode/CLAUDE.md</code> on macOS</td></tr>
          <tr><td>2. You, every project</td><td><code>~/.claude/CLAUDE.md</code> and <code>~/.claude/rules/</code></td></tr>
          <tr><td>3. The project, shared</td><td><code>./CLAUDE.md</code> or <code>./.claude/CLAUDE.md</code>, and <code>.claude/rules/*.md</code> without <code>paths</code></td></tr>
          <tr><td>4. The project, just you</td><td><code>./CLAUDE.local.md</code>, kept out of git</td></tr>
          <tr><td>Auto memory</td><td><code>~/.claude/projects/&lt;project&gt;/memory/MEMORY.md</code>: the first 200 lines or 25 KB</td></tr>
          <tr><td>Later, on demand</td><td>CLAUDE.md in subfolders, and rules whose <code>paths</code> match a file Claude touches</td></tr>
        </tbody></table></div><p class="small muted" style="margin:6px 0 0"><code>@path</code> imports pull other files in at start-up, up to four levels deep.</p>`
      },
      {
        t: 'You ask a question',
        term: [['p', 'The date test is flaky. Fix it.']],
        pk: [['you', 'cc', 'your prompt', 'you']],
        add: [U('u1', '"The date test is flaky. Fix it."', 20)],
        d: `CLAUDE.md is not part of the system prompt. Claude Code delivers it as a user message right after the system prompt, ahead of your conversation. That is why it is guidance the model weighs, not configuration that is enforced. In simplified form, the request looks like this:`,
        extra: `<pre class="code"><code>POST /v1/messages                                    <span class="c">simplified</span>
{
"model":  "…the model chosen with /model…",
"system": "…Claude Code's own instructions…",         <span class="c">← same every request</span>
"tools":  [ Read, Edit, Write, Bash, Agent, Skill, … ],
"messages": [
  { "role": "user", "content": [
      "…your CLAUDE.md files and auto memory…",       <span class="c">← CLAUDE.md is here</span>
      "The date test is flaky. Fix it." ] },
  <span class="c">…every reply and tool result so far…</span>
]
}</code></pre>`
      },
      {
        t: 'Request 1 writes the cache', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'tool_use: Read', 'resp']],
        resp: [T('a1', 'Claude: Read src/billing/dates.ts', 70)],
        term: [['tool', 'Read(src/billing/dates.ts)']],
        d: `The first request stores everything in the prompt cache: system prompt, tools, CLAUDE.md and your question. The cache lasts five minutes by default, or an hour for the main conversation on a subscription.`
      },
      {
        t: 'A CLAUDE.md in a subfolder loads on demand',
        pk: [['cc', 'files', 'read dates.ts', 'tool'], ['files', 'cc', 'file + src/billing/CLAUDE.md', 'file']],
        add: [T('r1', 'Result: src/billing/dates.ts', 1900), B('m-sub', 'mem', 'src/billing/CLAUDE.md', 350, 'loaded because Claude read a file in src/billing/'), B('m-rule', 'mem', '.claude/rules/billing.md', 200, 'its paths field matched src/billing/**')],
        term: [['out', 'Read 140 lines']],
        d: `CLAUDE.md files in subfolders are not loaded at start-up. They load the first time Claude reads or edits a file in that folder. Rules in <code>.claude/rules/</code> with a <code>paths</code> field work the same way. They join the conversation at that point, so the start of the request, and its cache, stays the same.`
      },
      {
        t: 'Request 2: CLAUDE.md is sent again', call: true,
        pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'tool_use: Edit', 'resp']],
        resp: [T('a2', 'Claude: Edit tests/dates.test.ts', 300)],
        term: [['tool', 'Update(tests/dates.test.ts)']],
        d: `Your CLAUDE.md goes out again, and it will go with every request for the rest of the session. This time it is read from the cache. Only what was added since the last request is new.`,
        why: `Every line of CLAUDE.md is paid for on every request. A 2,000-token file over a 50-request task is 100,000 input tokens, mostly cheap cache reads but never free. Keep it short and specific.`
      },
      {
        t: 'You edit CLAUDE.md mid-session',
        term: [['sys', '(you add a line to CLAUDE.md in your editor)']],
        on: ['files'],
        tags: [['warn', 'not applied yet']],
        d: `Nothing changes yet. Your project and user CLAUDE.md files are read once at start-up and kept in memory, which keeps the cache stable. The edit takes effect after <code>/clear</code>, <code>/compact</code> or a restart.`,
        why: `Changing the start of the request mid-session would make every later request miss the cache. Claude Code avoids that on purpose.`
      }
    ],
    after: `<div class="grid2">
      <div class="takeaways" style="margin-top:0"><h3>Remember</h3><ul>
        <li><b>CLAUDE.md is guidance, sent with every request.</b> For anything that must happen, use a hook or a permission rule.</li>
        <li><b>Keep it under about 200 lines.</b> Put procedures in skills and folder-specific rules in subfolder CLAUDE.md files or <code>.claude/rules/</code>.</li>
        <li><b>Add a line when Claude repeats a mistake,</b> and delete lines that no longer matter.</li>
        <li><b><code>/memory</code></b> lists every memory file that loaded and opens it. <b><code>/context</code></b> shows how much they use.</li>
      </ul></div>
      <div class="card"><h3 style="margin-top:0">What breaks the prompt cache mid-session</h3><ul class="small" style="padding-left:18px;margin:0">
        <li>Switching model, including through a skill's <code>model</code> field</li>
        <li>Changing effort, on some models</li>
        <li>Turning on fast mode</li>
        <li>Adding or removing MCP servers, when tool search is off</li>
        <li>Compaction, and upgrading Claude Code</li>
      </ul><p class="small" style="margin:8px 0 0"><b>Safe:</b> changing permission mode or output style, using skills, rewinding, and editing your code. <code>/usage</code> shows your cache hit rate and the likely cause of the last miss.</p></div>
    </div>`
  },

  // ------------------------------------------------------------------ 4
  {
    id: 'code', short: 'How code reaches the model', title: 'How your code reaches the model',
    sub: 'No upload and no index: the model sees only what its tools read',
    nodes: ['you', 'cc', 'api', 'files'],
    steps: [
      {
        t: 'What the model knows at the start',
        term: [['sh', 'claude'], ['p', 'The refund total is wrong when a coupon is applied. Fix it.']],
        pk: [['you', 'cc', 'your prompt', 'you']],
        add: [SYS, TOOLS, B('env', 'sys', 'Environment', 300, 'folder path, platform, shell, OS, git status snapshot'), MEM, U('u1', '"The refund total is wrong when a coupon is applied. Fix it."', 25)],
        d: `Your repository is not uploaded, and Claude Code does not build a search index of it. At the start the model has only this: Claude Code's instructions, the tool definitions, a few facts about your environment, your CLAUDE.md, which often names the key folders and commands, and your prompt. It has not seen a single line of your code.`,
        extra: `<pre class="code"><code><span class="c">The environment facts look roughly like this:</span>
Working directory: /Users/sam/dev/payments-api
Platform: darwin    Shell: zsh    Is a git repository: yes
Git status at start:  branch feature/coupons
 M src/services/refunds.ts
Recent commits:  3f2a1c9 Add coupon model</code></pre>`,
        why: `The model has to find code the way you would in a new codebase: search for names, open files, read them.`
      },
      {
        t: 'Request 1: the model searches for the code', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'tool_use: Bash grep', 'resp']],
        resp: [T('a1', 'Claude: Bash grep -rl "calculateRefund" src/', 60)],
        term: [['tool', 'Bash(grep -rl "calculateRefund" src/)']],
        d: `The model guesses a likely name from your prompt and asks Claude Code to search. There is no special code index: on macOS and Linux, Claude searches with ordinary <code>find</code> and <code>grep</code> through its Bash tool. This is the whole reply the model sends, a tool name and its inputs as JSON:`,
        extra: `<pre class="code"><code>{ "type": "tool_use", "id": "toolu_01", "name": "Bash",
"input": { "command": "grep -rl \\"calculateRefund\\" src/" } }</code></pre>`
      },
      {
        t: 'Claude Code searches your disk and returns file names',
        pk: [['cc', 'files', 'search src/', 'tool'], ['files', 'cc', '2 file names', 'file']],
        add: [T('r1', 'Result: 2 matching file names', 60, 'src/services/refunds.ts, src/routes/refunds.ts')],
        term: [['out', 'Found 2 files']],
        d: `The search runs on your machine. Only its output, two file paths, goes into the conversation. That is how the model learns file names: from search results, directory listings, git status and your CLAUDE.md.`
      },
      {
        t: 'Request 2: the model reads the file', call: true,
        pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'tool_use: Read', 'resp'], ['cc', 'files', 'read refunds.ts', 'tool'], ['files', 'cc', 'text, numbered lines', 'file']],
        resp: [T('a2', 'Claude: Read src/services/refunds.ts', 70), T('r2', 'Result: refunds.ts as numbered text', 2400, 'this is where your code enters the context')],
        term: [['tool', 'Read(src/services/refunds.ts)'], ['out', 'Read 96 lines']],
        d: `Claude Code reads the file and returns its text, with a line number on each line. This is the only way your code reaches the model: as the text of a tool result, inside the next request. One read returns at most about 25,000 tokens, so long files are read in parts.`,
        extra: `<pre class="code"><code><span class="c">The tool result the model receives</span>
  40
  41  export function calculateRefund(order: Order): number {
  42    const subtotal = sum(order.items.map(i =&gt; i.price * i.qty));
  43    return subtotal - order.coupon.amount;
  44  }</code></pre>`
      },
      {
        t: 'Request 3: the model writes the change as old text and new text', call: true,
        pk: [['cc', 'api', 'request 3, file included', 'req'], ['api', 'cc', 'tool_use: Edit', 'resp']],
        resp: [T('a3', 'Claude: Edit refunds.ts, old text → new text', 180)],
        term: [['tool', 'Update(src/services/refunds.ts)']],
        d: `The file you read goes out again with this request, from the cache, and stays in every request after it. The model does not send back the whole file, or a diff with line numbers. It copies the exact lines it saw and says what should replace them:`,
        extra: `<pre class="code wrap"><code>{ "type": "tool_use", "id": "toolu_03", "name": "Edit",
"input": {
  "file_path": "/Users/sam/dev/payments-api/src/services/refunds.ts",
  "old_string": "  return subtotal - order.coupon.amount;",
  "new_string": "  const discount = order.coupon ? applyCoupon(subtotal, order.coupon) : 0;\\n  return subtotal - discount;"
} }</code></pre>`,
        why: `That is how the model "knows what to change": it can only quote text it has read in this conversation.`
      },
      {
        t: 'Claude Code makes the change on your machine',
        pk: [['cc', 'you', 'allow this edit?', 'you'], ['you', 'cc', 'yes', 'you'], ['cc', 'files', 'find old text, replace', 'tool'], ['files', 'cc', 'saved', 'file']],
        add: [T('r3', 'Result: file updated, with a short snippet', 250, 'not the whole file again')],
        term: [['ask', ASK_EDIT('make this edit to refunds.ts')], ['diff', '41    export function calculateRefund(order: Order): number {\n42      const subtotal = sum(order.items.map(i => i.price * i.qty));\n43  -   return subtotal - order.coupon.amount;\n43  +   const discount = order.coupon ? applyCoupon(subtotal, order.coupon) : 0;\n44  +   return subtotal - discount;']],
        d: `Claude Code looks for the old text in the file. It must match exactly, spaces included, and appear only once, unless the model asks to replace every copy. There is no fuzzy matching. If the file has changed on disk and the old text no longer matches, the edit fails and the model reads the file again. Then Claude Code saves the file and sends back a short confirmation.`,
        why: `The model never touches your disk. It proposes text; Claude Code checks it, asks you, and writes the file.`
      },
      {
        t: 'A shortcut: point at the file yourself',
        term: [['p', 'Fix the coupon bug in @src/services/refunds.ts']],
        pk: [['you', 'cc', 'prompt with @file', 'you'], ['files', 'cc', 'file contents', 'file']],
        add: [U('u2', 'prompt + contents of @src/services/refunds.ts', 2450, 'attached by Claude Code')],
        d: `Typing <code>@</code> and a path makes Claude Code read the file and attach it to your prompt, along with any CLAUDE.md files in that file's folders, so the model skips the search and read rounds. A folder gives a file listing instead. Naming the right files is the quickest way to make Claude faster and cheaper.`,
        why: `Everything the tools return is sent to Anthropic's API as part of each request. Keep secrets out of reach with deny rules such as <code>Read(./.env)</code> (${go('permissions', 'chapter 12')}).`
      }
    ],
    after: `<div class="takeaways"><h3>Remember</h3><ul>
      <li><b>No upload, no index.</b> The model sees your code only through tool results in this conversation: searches, reads, command output.</li>
      <li><b>The model learns file names from tools</b> (search results, directory listings, git status) and from your CLAUDE.md. Listing the key folders there saves searching.</li>
      <li><b>Edits are text replacement.</b> The model quotes exact old text and gives new text. Claude Code applies it on your machine, after your permission rules allow it.</li>
      <li><b>What leaves your machine:</b> your prompts, the model's replies and everything in the context, including tool results. On commercial plans (Team, Enterprise, API), Anthropic does not train on it unless you opt in. Check your own plan and your company's policy.</li>
      <li><b>Every file read stays in the context</b> and goes out with every later request. Point Claude at the right files with <code>@</code>, and send wide exploration to a ${go('subagents', 'subagent')}.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 5
  {
    id: 'skills', short: 'Skills', title: 'Skills: instructions that load only when needed',
    sub: 'Progressive disclosure: a one-line description now, the full instructions on demand',
    nodes: ['you', 'cc', 'api', 'files'], nodeSub: { files: 'skills folders, scripts' },
    steps: [
      {
        t: 'Start-up: only names and descriptions',
        term: [['sh', 'claude']],
        pk: [['files', 'cc', 'name + description of each skill', 'file']],
        add: [SYS, TOOLS, ENV, MEM, B('skills', 'skill', 'Skill list: 6 skills', 600, 'name and description only')],
        d: `Claude Code scans the skill folders: yours in <code>~/.claude/skills/</code>, the project's in <code>.claude/skills/</code>, plus skills from plugins and those built into Claude Code. Only each skill's name and description go into the context. The list is capped at 1% of the context window; when there are too many, the descriptions of the least-used skills are dropped first.`,
        extra: `<div class="tree" style="font:12.5px/1.55 ui-monospace,Menlo,monospace;white-space:pre;overflow-x:auto;background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-top:6px">.claude/skills/
├── quarterly-report/
│   ├── SKILL.md              <span class="muted">loads when the skill is used</span>
│   ├── reference/charts.md   <span class="muted">loads only if SKILL.md sends Claude to it</span>
│   └── scripts/build_pdf.py  <span class="muted">runs; only its output enters the context</span>
└── release/
  └── SKILL.md</div>`
      },
      {
        t: 'You ask for something that matches a skill',
        term: [['p', 'Make the Q3 report from data/q3.csv']],
        pk: [['you', 'cc', 'your prompt', 'you']],
        add: [U('u1', '"Make the Q3 report from data/q3.csv"', 25)],
        d: `Nothing about your prompt names the skill. The model has to recognise that one of the descriptions in its context fits.`
      },
      {
        t: 'Request 1: the model picks the skill', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'tool_use: Skill', 'resp']],
        resp: [T('a1', 'Claude: Skill("quarterly-report")', 40)],
        term: [['tool', 'Skill(quarterly-report)']],
        d: `The model reads the description "Builds the quarterly finance report as a PDF. Use when asked for a quarterly or Q1 to Q4 report." It matches, so the model calls the Skill tool.`,
        why: `The description decides whether a skill is ever used. Say what it does and when to use it, with the words people actually type.`
      },
      {
        t: 'Claude Code loads the full SKILL.md',
        pk: [['cc', 'files', 'read SKILL.md', 'tool'], ['files', 'cc', '1,800 tokens of instructions', 'file']],
        add: [B('sk-body', 'skill', 'quarterly-report/SKILL.md', 1800, 'full instructions; stays for the rest of the session')],
        term: [['out', 'Loaded skill: quarterly-report']],
        d: `Now, and only now, the full instructions enter the context. They stay there for the rest of the conversation.`,
        extra: `<pre class="code wrap"><code>---
name: quarterly-report
description: Builds the quarterly finance report as a PDF. Use when asked for a quarterly or Q1 to Q4 report.
---

1. Check the CSV has the columns month, region, revenue, cost.
2. If the user wants charts, read reference/charts.md first.
3. Run: python .claude/skills/quarterly-report/scripts/build_pdf.py &lt;csv&gt; --out reports/
4. Reply with the PDF path and the three biggest changes since last quarter.</code></pre>`
      },
      {
        t: 'Request 2: Claude follows the steps', call: true,
        pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'tool_use: Bash', 'resp'], ['cc', 'files', 'run build_pdf.py', 'tool'], ['files', 'cc', 'reports/q3.pdf', 'file']],
        resp: [T('a2', 'Claude: Bash build_pdf.py data/q3.csv', 60), T('r2', 'Result: reports/q3.pdf, 6 pages', 80)],
        term: [['tool', 'Bash(python .claude/skills/quarterly-report/scripts/build_pdf.py data/q3.csv --out reports/)'], ['out', 'Wrote reports/q3.pdf (6 pages)']],
        d: `The script runs on your machine. The model never reads its 400 lines of code, only the 80 tokens it prints. No charts were asked for, so <code>reference/charts.md</code> never loaded. That is progressive disclosure: the description first, the instructions when needed, extra files only if needed.`
      },
      {
        t: 'Or start a skill yourself: /release minor',
        term: [['p', '/release minor']],
        pk: [['you', 'cc', '/release minor', 'you'], ['files', 'cc', 'release/SKILL.md', 'file']],
        add: [B('sk-rel', 'skill', 'release/SKILL.md, with $ARGUMENTS = minor', 700, 'you typed it, so no model decision was needed')],
        d: `Typing <code>/skill-name</code> loads the skill straight away, with what you typed after it in place of <code>$ARGUMENTS</code>. A skill with <code>disable-model-invocation: true</code> can only start this way, which is what you want for anything with side effects, such as releases and deploys.`,
        why: `After compaction, the skills you used are attached again: up to 5,000 tokens each and 25,000 in total.`
      }
    ],
    after: `<h2 style="margin-top:8px">All the kinds of skills</h2>
      <div class="table-wrap"><table class="t"><thead><tr><th>Kind</th><th>Where it lives</th><th>How you call it</th></tr></thead><tbody>
        <tr><td>Built into Claude Code</td><td>Ships with Claude Code. Turn them off with the <code>disableBundledSkills</code> setting.</td><td><code>/simplify</code>, <code>/code-review</code> and others below</td></tr>
        <tr><td>Your own, every project</td><td><code>~/.claude/skills/&lt;name&gt;/SKILL.md</code></td><td><code>/name</code>, or Claude picks it</td></tr>
        <tr><td>The project's, shared in git</td><td><code>.claude/skills/&lt;name&gt;/SKILL.md</code>, also in subfolders</td><td><code>/name</code>, or Claude picks it</td></tr>
        <tr><td>Organisation</td><td>Managed settings, set by an administrator</td><td>Wins over personal and project skills with the same name</td></tr>
        <tr><td>From a plugin</td><td><code>&lt;plugin&gt;/skills/&lt;name&gt;/SKILL.md</code></td><td><code>/plugin-name:skill-name</code></td></tr>
        <tr><td>Older custom commands</td><td><code>.claude/commands/&lt;name&gt;.md</code>; still works</td><td><code>/name</code></td></tr>
      </tbody></table></div>

      <h3>Skills that come with Claude Code</h3>
      <p class="small muted">From the commands reference in October 2026. The set changes between versions, so type <code>/</code> in Claude Code to see yours.</p>
      <div class="skillgrid">
        <div class="mini"><b><code>/code-review</code></b>Reviews a diff, branch or pull request for correctness bugs. <code>/review</code> is an alias.</div>
        <div class="mini"><b><code>/simplify</code></b>Four review agents look for cleanup in parallel, then the fixes are applied.</div>
        <div class="mini"><b><code>/batch &lt;instruction&gt;</code></b>Plans a large change, splits it into 5 to 30 units and runs them in parallel.</div>
        <div class="mini"><b><code>/debug</code></b>Turns on debug logging and troubleshoots from the session's debug log.</div>
        <div class="mini"><b><code>/doctor</code></b>Checks your setup and proposes fixes, applied after you confirm.</div>
        <div class="mini"><b><code>/loop [interval] [prompt]</code></b>Repeats a prompt on an interval while the session stays open.</div>
        <div class="mini"><b><code>/verify</code> and <code>/run</code></b>Build, launch and drive your app to confirm a change works.</div>
        <div class="mini"><b><code>/fewer-permission-prompts</code></b>Builds a read-only allow list in project settings from your past sessions.</div>
        <div class="mini"><b><code>/update-config</code></b>Edits settings, permissions, environment variables or hooks for you.</div>
        <div class="mini"><b><code>/claude-api</code></b>Loads the Claude API and SDK reference, for building on the API.</div>
        <div class="mini"><b><code>/dataviz</code></b>Design guidance for charts, graphs and dashboards.</div>
        <div class="mini"><b><code>/claude-in-chrome</code></b>Drives a task in your browser. Needs the Chrome integration.</div>
      </div>
      <p class="small"><code>/init</code>, <code>/memory</code>, <code>/config</code> and <code>/security-review</code> are built-in commands, not skills.</p>

      <div class="grid2">
        <div class="card"><h3 style="margin-top:0">Anthropic's pre-built skills</h3><p class="small" style="margin:0">The <b>pptx</b>, <b>xlsx</b>, <b>docx</b> and <b>pdf</b> skills create and edit PowerPoint, Excel, Word and PDF files. They work in the Claude apps on claude.ai and through the Claude API, where you select them by <code>skill_id</code>. They are <b>not</b> part of Claude Code. Open-source examples are in the <code>anthropics/skills</code> repository on GitHub.</p></div>
        <div class="card"><h3 style="margin-top:0">A skill for writing skills</h3><p class="small" style="margin:0">Install <code>/plugin install skill-creator@claude-plugins-official</code> and ask Claude to help you write, test and improve a skill. Custom skills do not sync between Claude Code, claude.ai and the API; add them to each one separately.</p></div>
      </div>

      <h3>Every SKILL.md frontmatter field</h3>
      <p class="small muted">No field is required. Write <code>description</code> in every skill.</p>
      <div class="table-wrap"><table class="t"><thead><tr><th>Field</th><th>What it does</th></tr></thead><tbody>
        <tr><td><code>name</code></td><td>The command name. Defaults to the folder name.</td></tr>
        <tr><td><code>description</code></td><td>What it does and when to use it. Claude reads this to decide.</td></tr>
        <tr><td><code>when_to_use</code></td><td>Extra guidance on when to use it, listed with the description.</td></tr>
        <tr><td><code>argument-hint</code>, <code>arguments</code></td><td>The hint shown as you type, such as <code>[patch|minor|major]</code>, and named arguments used as <code>$name</code>. <code>$ARGUMENTS</code> is everything typed; <code>$0</code> is the first argument.</td></tr>
        <tr><td><code>disable-model-invocation</code></td><td><code>true</code>: only you can start it. Use it for side effects.</td></tr>
        <tr><td><code>user-invocable</code></td><td><code>false</code>: hidden from the <code>/</code> menu; Claude loads it as background knowledge.</td></tr>
        <tr><td><code>allowed-tools</code>, <code>disallowed-tools</code></td><td>Tools it may use without asking, or may not use, while it runs.</td></tr>
        <tr><td><code>model</code>, <code>effort</code></td><td>Run with another model or effort level. Switching model misses the prompt cache.</td></tr>
        <tr><td><code>context: fork</code>, <code>agent</code>, <code>background</code></td><td>Run in a subagent of the given type, in the background by default, so the work stays out of your context.</td></tr>
        <tr><td><code>hooks</code></td><td>Hooks that apply while this skill is running.</td></tr>
        <tr><td><code>paths</code></td><td>File patterns that limit when the skill applies.</td></tr>
      </tbody></table></div>
      <p class="small">A line such as <code>!\`git diff HEAD\`</code> in SKILL.md runs before Claude reads the skill, and its output replaces the line. If the command fails, the skill does not run. The <a href="/claude-code#skills">Claude Code setup lab</a> has two complete examples.</p>
      <div class="takeaways"><h3>Remember</h3><ul>
        <li><b>Skills cost almost nothing until used.</b> Move procedures out of CLAUDE.md into skills.</li>
        <li><b>Write the description for the decision,</b> with the main use first.</li>
        <li><b>Put deterministic work in scripts.</b> They run identically every time and only their output costs context.</li>
        <li><b>Mark side effects</b> with <code>disable-model-invocation: true</code>.</li>
      </ul></div>`
  },

  // ------------------------------------------------------------------ 6
  {
    id: 'hooks', short: 'Hooks', title: 'Hooks: your code at fixed moments',
    sub: 'Scripts that Claude Code runs every time. The model cannot skip them.',
    nodes: ['you', 'cc', 'api', 'files', 'hooks'], nodeSub: { hooks: 'protect, format, test' },
    steps: [
      {
        t: 'SessionStart: a hook adds context',
        term: [['sh', 'claude'], ['hook', 'SessionStart: .claude/hooks/sprint-context.sh']],
        pk: [['cc', 'hooks', 'SessionStart', 'hook'], ['hooks', 'cc', 'stdout: open tickets', 'hook']],
        add: [SYS, TOOLS, ENV, MEM, B('h-start', 'hook', 'SessionStart hook output', 250, 'current sprint and open tickets')],
        d: `Hooks are commands in your settings files that Claude Code runs at fixed points in a session. Each one receives the event as JSON on standard input. For SessionStart and UserPromptSubmit, whatever the script prints is added to Claude's context.`
      },
      {
        t: 'You ask, and UserPromptSubmit runs first',
        term: [['p', 'Point the app at the new payments database']],
        pk: [['you', 'cc', 'your prompt', 'you'], ['cc', 'hooks', 'UserPromptSubmit', 'hook'], ['hooks', 'cc', 'exit 0', 'hook']],
        add: [U('u1', '"Point the app at the new payments database"', 25)],
        d: `Before the model sees your prompt, this hook can check it, add context to it or block it. Exit code 0 lets it through.`
      },
      {
        t: 'The model wants to edit .env', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'tool_use: Edit .env', 'resp']],
        resp: [T('a1', 'Claude: Edit .env', 120)],
        term: [['tool', 'Update(.env)']],
        d: `A reasonable guess by the model, but your team keeps secrets in <code>.env</code> and never wants an agent changing it.`
      },
      {
        t: 'PreToolUse: the hook blocks it',
        pk: [['cc', 'hooks', 'PreToolUse: Edit .env', 'hook'], ['hooks', 'cc', 'exit 2: protected', 'bad']],
        add: [B('r1', 'bad', 'Result: blocked by a hook', 40, 'Blocked: .env is protected. Use config/database.ts.')],
        term: [['bad', 'PreToolUse hook blocked Update(.env): Blocked: .env is protected. Use config/database.ts.']],
        tags: [['bad', 'exit code 2']],
        d: `Exit code 2 blocks the call. The edit never happens, and what the script wrote to standard error goes back to Claude as the reason. "Never edit .env" in CLAUDE.md is a request. This is a rule.`,
        extra: `<pre class="code"><code>#!/usr/bin/env bash
<span class="c"># .claude/hooks/protect-files.sh: exit code 2 blocks the call</span>
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
*.env) echo "Blocked: .env is protected. Use config/database.ts." >&2; exit 2 ;;
esac
exit 0</code></pre>`
      },
      {
        t: 'Claude adapts, and PostToolUse formats the file', call: true,
        pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'tool_use: Edit database.ts', 'resp'], ['cc', 'hooks', 'PreToolUse', 'hook'], ['hooks', 'cc', 'exit 0', 'hook'], ['cc', 'files', 'edit', 'tool'], ['cc', 'hooks', 'PostToolUse', 'hook'], ['hooks', 'cc', 'formatted', 'hook']],
        resp: [T('a2', 'Claude: Edit config/database.ts', 300), T('r2', 'Result: edit applied', 80)],
        term: [['tool', 'Update(config/database.ts)'], ['out', 'Updated config/database.ts with 3 additions and 1 removal'], ['hook', 'PostToolUse: prettier --write config/database.ts']],
        d: `The model used the hook's message to find the right file. After the edit, a PostToolUse hook runs the formatter. Claude did not decide to format; the hook runs after every matching edit.`
      },
      {
        t: 'Claude says it is done. The Stop hook disagrees.', call: true,
        pk: [['cc', 'api', 'request 3', 'req'], ['api', 'cc', '"Done", end_turn', 'resp'], ['cc', 'hooks', 'Stop', 'hook'], ['hooks', 'cc', 'exit 2: 2 tests fail', 'bad']],
        resp: [C('a3', '"Done. The app now uses the new database."', 60), B('h-stop', 'hook', 'Stop hook: 2 tests failing', 300, 'Claude must keep working')],
        term: [['say', 'Done. The app now reads the new database URL.'], ['bad', 'Stop hook: npm test failed, 2 tests failing in tests/db.test.ts']],
        tags: [['bad', 'exit code 2']],
        d: `A Stop hook runs when Claude finishes its answer. Exit code 2 sends the reason back, and Claude keeps working. This is how you make "done" mean "the tests pass". After 8 continuations in a row Claude Code ends the turn anyway, so a broken check cannot loop forever.`
      },
      {
        t: 'Claude fixes the tests, and the Stop hook passes', call: 2,
        pk: [['cc', 'api', 'requests 4–5', 'req'], ['api', 'cc', 'fix, then end_turn', 'resp'], ['cc', 'hooks', 'Stop', 'hook'], ['hooks', 'cc', 'exit 0', 'hook'], ['cc', 'you', 'answer', 'you']],
        resp: [T('a4', 'Claude: Edit tests/db.test.ts, Bash npm test', 900), C('a5', '"Done, and all 45 tests pass."', 50)],
        term: [['tool', 'Update(tests/db.test.ts)'], ['tool', 'Bash(npm test)'], ['out', '45 passed'], ['say', 'Done. The app uses the new database and all 45 tests pass.'], ['hook', 'Stop: tests pass']],
        tags: [['good', 'exit code 0']],
        d: `Look at the context: the formatter ran without adding anything. Only the SessionStart output and the two blocks reached the model. Hooks add context only when they are designed to.`
      }
    ],
    after: `<div class="grid2">
      <div><h3 style="margin-top:0">.claude/settings.json</h3><pre class="code"><code>{
"hooks": {
  "PreToolUse": [
    { "matcher": "Edit|Write",
      "hooks": [{ "type": "command",
        "command": "\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/protect-files.sh" }] }
  ],
  "PostToolUse": [
    { "matcher": "Edit|Write",
      "hooks": [{ "type": "command",
        "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write" }] }
  ],
  "Stop": [
    { "hooks": [{ "type": "command",
        "command": "npm test --silent || { echo 'Tests failing' >&2; exit 2; }" }] }
  ]
}
}</code></pre></div>
      <div><h3 style="margin-top:0">The parts</h3><div class="table-wrap"><table class="t"><tbody>
        <tr><td><b>Events</b></td><td>33 in all. The main ones: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Notification, SubagentStop, Stop, PreCompact, SessionEnd.</td></tr>
        <tr><td><b>Handlers</b></td><td><code>command</code> (a shell command), <code>http</code>, <code>mcp_tool</code>, <code>prompt</code> (a quick model check) and <code>agent</code> (experimental).</td></tr>
        <tr><td><b>Exit 0</b></td><td>Carry on. Standard output may be JSON with a decision, such as <code>permissionDecision</code> for PreToolUse.</td></tr>
        <tr><td><b>Exit 2</b></td><td>Block, on events that can block. Standard error is the reason Claude sees.</td></tr>
        <tr><td><b>Other codes</b></td><td>A non-blocking error: the action still goes ahead.</td></tr>
        <tr><td><b>Where</b></td><td>User, project or local settings, managed policy, plugins, and skill or subagent frontmatter. <code>/hooks</code> lists them all.</td></tr>
      </tbody></table></div></div>
    </div>
    <div class="takeaways"><h3>Remember</h3><ul>
      <li><b>Instructions can be forgotten; hooks cannot.</b> Use them for anything that must always or must never happen.</li>
      <li><b>Use exit code 2 to enforce.</b> Exit code 1 only reports an error.</li>
      <li><b>Hooks run with your permissions.</b> Read every hook before you add it, especially from someone else's repository or plugin.</li>
      <li><b>Keep them fast,</b> because they run on every matching event.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 7
  {
    id: 'mcp', short: 'MCP', title: 'MCP: connecting outside tools',
    sub: 'Claude Code as an MCP client, and how tool search keeps it cheap',
    nodes: ['you', 'cc', 'api', 'mcp'], nodeSub: { mcp: 'issues tracker' },
    steps: [
      {
        t: 'You add a server, once',
        term: [['sh', 'claude mcp add --transport http issues https://mcp.example.com/mcp'], ['out', 'Added HTTP MCP server issues'], ['sh', 'claude mcp add --transport stdio db -- node ./tools/db-server.js']],
        pk: [['you', 'cc', 'claude mcp add', 'you']],
        d: `An MCP server is a program that offers tools through the Model Context Protocol. A local server runs as a process on your machine and talks over standard input and output (stdio). A remote one is a URL reached over HTTP. Add <code>--scope project</code> to save it in <code>.mcp.json</code> so the whole team gets it; each teammate approves it the first time.`
      },
      {
        t: 'Start-up: Claude Code connects and lists the tools',
        term: [['sh', 'claude']],
        pk: [['cc', 'mcp', 'initialize, tools/list', 'mcp'], ['mcp', 'cc', '31 tools', 'mcp']],
        add: [SYS, TOOLS, ENV, MEM, B('mcpn', 'mcp', 'MCP tool names, deferred', 350, '31 names; the full definitions could be 15,000 tokens')],
        d: `Claude Code starts each local server, or connects to its URL, and asks what tools it has. Tool search is on by default, so only the tool names go into the context. Full definitions load when the model needs them.`,
        why: `Without tool search, every definition from every server would be sent with every request, used or not.`
      },
      {
        t: 'You ask for something that needs the server',
        term: [['p', 'What is the most common checkout error this week? Open an issue for it.']],
        pk: [['you', 'cc', 'your prompt', 'you']],
        add: [U('u1', '"What is the most common checkout error…?"', 30)],
        d: `The model knows tools called <code>mcp__issues__…</code> exist, but not yet how to call them.`
      },
      {
        t: 'Request 1: the model searches for tools', call: true,
        pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'ToolSearch "errors issues"', 'resp']],
        resp: [T('a1', 'Claude: ToolSearch("errors issues")', 40), B('mcp-defs', 'mcp', '2 full tool definitions', 900, 'search_errors and create_issue')],
        term: [['tool', 'ToolSearch("errors issues")'], ['out', 'Found 2 tools']],
        d: `The model searches the deferred tools and Claude Code adds the full definitions of just the two that match. They are added later in the conversation rather than to the tool list at the start, so the cached start of the request stays the same.`
      },
      {
        t: 'Request 2: calling an MCP tool', call: true,
        pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'mcp__issues__search_errors', 'resp'], ['cc', 'mcp', 'tools/call', 'mcp'], ['mcp', 'cc', 'top errors', 'mcp']],
        resp: [T('a2', 'Claude: mcp__issues__search_errors', 60), T('r2', 'Result: top checkout errors this week', 2800)],
        term: [['tool', 'issues - search_errors (MCP)(service: "checkout", since: "7d")'], ['out', 'TypeError: cannot read "amount" of undefined, 412 events']],
        d: `MCP tools are named <code>mcp__server__tool</code>. Claude Code passes the call to the server and adds the result to the conversation like any other tool result. It warns when a result is over 10,000 tokens and cuts it at 25,000 by default; <code>MAX_MCP_OUTPUT_TOKENS</code> changes the limit.`
      },
      {
        t: 'Request 3: an action, so you are asked', call: true,
        pk: [['cc', 'api', 'request 3', 'req'], ['api', 'cc', 'tool_use: create_issue', 'resp'], ['cc', 'you', 'allow?', 'you'], ['you', 'cc', 'yes', 'you'], ['cc', 'mcp', 'tools/call', 'mcp'], ['mcp', 'cc', 'issue #231', 'mcp']],
        resp: [T('a3', 'Claude: mcp__issues__create_issue', 200), T('r3', 'Result: issue #231 created', 60)],
        term: [['tool', 'issues - create_issue (MCP)'], ['ask', "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for this tool\n  3. No"], ['out', 'Created issue #231']],
        d: `MCP tools go through the same permission checks and hooks as built-in tools. A matcher such as <code>mcp__issues__.*</code> targets them in hooks.`
      },
      {
        t: 'The answer', call: true,
        pk: [['cc', 'api', 'request 4', 'req'], ['api', 'cc', 'answer, end_turn', 'resp'], ['cc', 'you', 'answer', 'you']],
        resp: [C('a4', '"The top error is a TypeError, 412 events. Issue #231."', 80)],
        term: [['say', 'The most common checkout error this week is a TypeError when a payment has no amount: 412 events. I opened issue #231 with the stack trace.']],
        d: `Treat MCP results like any outside text. A server can return instructions that someone planted, so connect only servers you trust and keep approval on for actions.`
      }
    ],
    after: `<div class="grid2">
      <div class="table-wrap"><table class="t"><thead><tr><th>Scope</th><th>Stored in</th><th>Who gets it</th></tr></thead><tbody>
        <tr><td><code>local</code> (default)</td><td><code>~/.claude.json</code>, under this project</td><td>You, in this project</td></tr>
        <tr><td><code>project</code></td><td><code>.mcp.json</code> in the repository</td><td>Everyone who clones it, after approving</td></tr>
        <tr><td><code>user</code></td><td><code>~/.claude.json</code></td><td>You, in every project</td></tr>
      </tbody></table></div>
      <div class="table-wrap"><table class="t"><tbody>
        <tr><td><code>/mcp</code></td><td>Server status and tool counts, sign in to remote servers, turn servers on or off</td></tr>
        <tr><td><code>@server:resource</code></td><td>Attach an MCP resource to your prompt</td></tr>
        <tr><td><code>/server:prompt</code></td><td>Run a prompt that a server provides</td></tr>
        <tr><td>Transports</td><td><code>http</code> for remote servers, <code>stdio</code> for local ones. SSE is deprecated.</td></tr>
      </tbody></table></div>
    </div>
    <div class="takeaways"><h3>Remember</h3><ul>
      <li><b>MCP is how Claude Code reaches systems outside your repository:</b> issue trackers, databases, monitoring, design tools.</li>
      <li><b>Tool search keeps many servers affordable,</b> but every tool result still lands in your context. Prefer tools that return short, filtered results.</li>
      <li><b>A server runs with your access.</b> Install only servers you trust, and remember that their output can carry prompt injection (see the <a href="/injection">Prompt injection lab</a>).</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 8
  {
    id: 'plugins', short: 'Plugins', title: 'Plugins: share the whole setup',
    sub: 'One install brings skills, subagents, hooks and MCP servers',
    nodes: ['you', 'cc', 'files', 'hooks', 'mcp', 'market'], nodeSub: { files: 'plugin cache, settings' },
    steps: [
      {
        t: "Add your team's marketplace",
        term: [['p', '/plugin marketplace add acme/claude-plugins']],
        pk: [['you', 'cc', '/plugin marketplace add', 'you'], ['cc', 'market', 'fetch marketplace.json', 'req'], ['market', 'cc', 'list of plugins', 'resp']],
        add: [SYS, TOOLS, ENV, MEM, SKL],
        d: `A marketplace is a git repository, URL or folder with a <code>.claude-plugin/marketplace.json</code> file that lists plugins. Anthropic's official marketplace, <code>claude-plugins-official</code>, is added for you automatically.`
      },
      {
        t: 'Install a plugin',
        term: [['p', '/plugin install team-tools@acme'], ['out', 'Installed team-tools']],
        pk: [['you', 'cc', '/plugin install', 'you'], ['market', 'cc', 'download team-tools', 'resp'], ['cc', 'files', 'store the plugin', 'tool']],
        d: `The plugin is downloaded to your machine. Inside it is an ordinary set of Claude Code pieces, with a manifest:`,
        extra: `<div style="font:12.5px/1.55 ui-monospace,Menlo,monospace;white-space:pre;overflow-x:auto;background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:8px 12px">team-tools/
├── .claude-plugin/plugin.json   <span class="muted">name, version, description</span>
├── skills/deploy-check/SKILL.md
├── agents/security-reviewer.md
├── hooks/hooks.json
└── .mcp.json</div>`
      },
      {
        t: 'Each part goes where it belongs',
        term: [['sys', '(team-tools adds 2 skills, 1 subagent, 2 hooks and 1 MCP server)']],
        pk: [['files', 'cc', 'plugin.json', 'file'], ['cc', 'hooks', 'add 2 hooks', 'hook'], ['cc', 'mcp', 'start MCP server', 'mcp']],
        add: [B('pl-skills', 'skill', 'Skill list: + team-tools:deploy-check, team-tools:changelog', 140, 'named after the plugin'), B('pl-agent', 'sys', 'Subagent list: + team-tools:security-reviewer', 60, 'listed for the Agent tool'), B('pl-mcp', 'mcp', 'MCP tool names from the plugin server', 120, 'deferred, names only')],
        d: `Skills and subagents are named after the plugin, such as <code>/team-tools:deploy-check</code>, so two plugins never clash. Hooks join your own hooks. The MCP server starts like any other. Only the descriptions and tool names cost context.`
      },
      {
        t: 'Use it like anything else',
        term: [['p', '/team-tools:deploy-check']],
        pk: [['you', 'cc', '/team-tools:deploy-check', 'you'], ['files', 'cc', 'SKILL.md', 'file']],
        add: [B('pl-body', 'skill', 'team-tools:deploy-check SKILL.md', 900, 'loaded on demand')],
        d: `From here it is exactly ${go('skills', 'chapters 5')} to 7: the skill loads when used, the hooks run at their events, and the MCP tools are found with tool search.`
      },
      {
        t: 'Share it with the team through git',
        term: [['sh', 'claude plugin install team-tools@acme --scope project'], ['sh', 'git add .claude/settings.json && git commit -m "Use team-tools"']],
        pk: [['cc', 'files', 'write .claude/settings.json', 'tool']],
        d: `With <code>--scope project</code> the plugin is recorded in <code>.claude/settings.json</code>, through the <code>enabledPlugins</code> and <code>extraKnownMarketplaces</code> settings. Commit that file and teammates get the same setup in this repository.`
      }
    ],
    after: `<div class="grid2">
      <pre class="code"><code><span class="c"># Browse, install, enable and disable</span>
/plugin

<span class="c"># Add a marketplace, then install from it</span>
/plugin marketplace add acme/claude-plugins
/plugin install team-tools@acme

<span class="c"># Try a plugin you are writing, for one session</span>
claude --plugin-dir ./team-tools

<span class="c"># Turn one off without removing it</span>
claude plugin disable team-tools</code></pre>
      <div class="takeaways" style="margin-top:10px"><h3>Remember</h3><ul>
        <li><b>Start without a plugin.</b> Package skills and hooks once other repositories or teams need them.</li>
        <li><b>Keep plugins focused.</b> Every enabled plugin's descriptions sit in context.</li>
        <li><b>A plugin can run code on your machine</b> through hooks and MCP servers. Install only from sources you trust.</li>
        <li>The <a href="/claude-code#plugins">Claude Code setup lab</a> and <code>examples/claude-code/my-first-plugin/</code> have a working plugin to copy.</li>
      </ul></div>
    </div>`
  },

  // ------------------------------------------------------------------ 9
  {
    id: 'subagents', short: 'Subagents', title: 'Subagents: a fresh context for side work',
    sub: 'Delegate the reading, keep only the answer',
    nodes: ['you', 'cc', 'api', 'files', 'sub'], nodeSub: { sub: 'Explore, read-only' },
    callsBefore: 30,
    init: [SYS, TOOLS, ENV, MEM, B('hist', 'msg', 'Earlier in this session', 22000, 'your previous requests, replies and results')],
    warm: true,
    steps: [
      {
        t: 'You ask a broad question',
        term: [['p', 'Where do we parse dates, and are any of them timezone-unsafe?']],
        pk: [['you', 'cc', 'your prompt', 'you']],
        add: [U('u1', '"Where do we parse dates…?"', 25)],
        d: `Answering means reading a lot of code. Doing that in the main conversation would fill it with file contents you will never look at again.`
      },
      {
        t: 'The model delegates', call: true,
        pk: [['cc', 'api', 'request', 'req'], ['api', 'cc', 'tool_use: Agent (Explore)', 'resp']],
        resp: [T('a1', 'Claude: Agent(Explore, "find date parsing…")', 120)],
        term: [['tool', 'Explore(Find date parsing and timezone risks)']],
        d: `The model calls the Agent tool with a task and a subagent type. Explore is a built-in, read-only subagent for searching code. Plan and general-purpose are built in too, and you can define your own in <code>.claude/agents/</code>.`
      },
      {
        t: 'Claude Code starts the subagent with an empty context',
        pk: [['cc', 'sub', 'task + its own instructions', 'req']],
        subAdd: [B('s-sys', 'sys', 'Its system prompt and tools', 9000, 'read-only tools'), B('s-mem', 'mem', 'CLAUDE.md', 1500, 'unless its definition turns this off'), B('s-task', 'msg', 'The task text', 120, 'not your conversation')],
        d: `The subagent does not see your conversation. It gets its own system prompt, its own tools and the task the main agent wrote. A second context window appears below.`
      },
      {
        t: 'The subagent works in its own loop',
        pk: [['sub', 'api', 'request', 'req'], ['api', 'sub', 'grep, Read ×12', 'resp'], ['sub', 'cc', 'run tools', 'tool'], ['cc', 'files', 'read files', 'tool'], ['files', 'cc', 'contents', 'file'], ['cc', 'sub', 'results', 'file']],
        subAdd: [B('s-work', 'tool', '12 files read, 4 searches', 46000, "all of it in the subagent's context")],
        term: [['out', 'Bash(grep -rn "new Date(") · Read src/billing/dates.ts · Read src/reports/export.ts · +13 more']],
        d: `It runs the same agent loop as ${go('loop', 'chapter 2')}, many times over. Its tool calls still go through Claude Code, so your permission rules apply. Its context fills with file contents. Yours does not move.`
      },
      {
        t: 'Only the final report comes back',
        pk: [['sub', 'cc', 'final report', 'resp']],
        add: [T('r1', 'Result: the Explore report', 900, "the subagent's final message, nothing else")],
        subClear: true,
        term: [['out', 'Done (16 tool uses · 57k tokens)']],
        d: `When it finishes, its last message becomes the tool result in your conversation, and the rest of its context is thrown away. About 57,000 tokens of reading cost your main context 900.`
      },
      {
        t: 'The main agent answers', call: true,
        pk: [['cc', 'api', 'request', 'req'], ['api', 'cc', 'answer', 'resp'], ['cc', 'you', 'answer', 'you']],
        resp: [C('a2', '"Three places are timezone-unsafe…"', 200)],
        term: [['say', 'I found 9 places that parse dates. Three are timezone-unsafe: src/billing/dates.ts:41, src/reports/export.ts:88 and src/jobs/nightly.ts:17. Shall I fix them?']],
        d: `The trade-off: a subagent spends more tokens in total, and the main agent sees only its summary, not the details. Use one when the reading would flood your context, or when separate pieces of work can run in parallel.`
      }
    ],
    after: `<div class="grid2">
      <pre class="code"><code><span class="c"># .claude/agents/code-reviewer.md</span>
---
name: code-reviewer
description: Reviews a diff for bugs and risky changes. Use after any non-trivial edit.
tools: Read, Glob, Grep
model: sonnet
---

You are a careful code reviewer. Report real problems only,
with file and line, most serious first.</code></pre>
      <div class="takeaways" style="margin-top:10px"><h3>Remember</h3><ul>
        <li><b>Built in:</b> Explore (fast, read-only search), Plan (research for plan mode) and general-purpose (all tools).</li>
        <li><b>Only <code>name</code> and <code>description</code> are required.</b> Give each one only the tools it needs.</li>
        <li><b>Subagents can start their own subagents,</b> up to three levels deep by default. <span class="kbd">Ctrl+B</span> sends a running one to the background.</li>
        <li><b>Agent teams</b>, several Claude sessions with a shared task list, are experimental and off by default.</li>
      </ul></div>
    </div>`
  },

  // ------------------------------------------------------------------ 10
  {
    id: 'context', short: 'Context & /compact', title: 'The context window and compaction',
    sub: 'What fills it, and what happens when it is nearly full',
    nodes: ['you', 'cc', 'api', 'files'],
    callsBefore: 140,
    init: [SYS, TOOLS, ENV, MEM, SKL, MCPD, B('h1', 'msg', 'Turns 1–20: prompts and replies', 9000), B('t1', 'tool', 'Turns 1–20: tool calls and results', 52000, 'file contents, test output, diffs')],
    warm: true,
    term0: [['sys', '(an hour into a session: 20 turns so far)']],
    steps: [
      {
        t: '/context: see what is using the window',
        term: [['p', '/context'], ['box', 'Context usage   78.7k of 200k tokens (39%)\n  System prompt and tools   15.3k\n  Memory files               1.5k\n  Skills                     0.6k\n  MCP tools (deferred)       0.3k\n  Messages                  61.0k\n  Free space               121.3k']],
        pk: [['you', 'cc', '/context', 'you']],
        d: `<code>/context</code> draws a map of the window, with suggestions when something is large. The layout above is simplified. Notice where the space goes: in a long session most of it is tool results, such as file contents, test output and diffs.`
      },
      {
        t: 'The session goes on',
        term: [['sys', '… 25 more turns …']],
        add: [B('h2', 'msg', 'Turns 21–45: prompts and replies', 11000), B('t2', 'tool', 'Turns 21–45: tool calls and results', 76000)],
        d: `Every turn adds to the conversation, and every request sends all of it. Quality can slip well before the window is full: there is more for the model to search through, and old details compete with new ones.`,
        why: `Start a new conversation for each new task. It is the simplest way to keep Claude sharp and cheap.`
      },
      {
        t: 'Nearly full: auto-compact starts',
        term: [['sys', 'Compacting conversation…']],
        pk: [['cc', 'api', 'summarise this conversation', 'req'], ['api', 'cc', 'summary', 'resp']],
        tags: [['warn', 'automatic']],
        d: `When the conversation nears the limit, Claude Code first clears older tool outputs, then asks the model to summarise the conversation. <code>/autocompact</code> sets the window size it works to, from 100,000 to 1,000,000 tokens.`
      },
      {
        t: 'After compaction',
        term: [['ok', 'Conversation compacted']],
        pk: [['files', 'cc', 'CLAUDE.md + recent files', 'file']],
        del: ['h1', 't1', 'h2', 't2'],
        set: { mem: { note: 're-read from disk' } },
        add: [B('sum', 'sum', 'Summary of the conversation so far', 6000, 'requests, decisions, files changed, next steps'), B('refiles', 'tool', 'Recently changed files, read again', 9000, 'up to five'), B('reskills', 'skill', 'Skills used so far, attached again', 2000, 'up to 5,000 tokens each')],
        d: `The conversation is replaced by a summary. <b>Kept:</b> the system prompt, your project CLAUDE.md and rules (read again from disk, so mid-session edits now apply), auto memory, the plan from plan mode, up to five recently changed files and the skills you used. <b>Lost:</b> instructions you only gave in the chat, and the detail of old tool output.`,
        extra: `<p class="small muted" style="margin:0">After compaction, the conversation the model sees begins with a line like: <i>"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation."</i></p>`
      },
      {
        t: 'The next request is much smaller', call: true,
        term: [['p', 'Now add the refund endpoint']],
        pk: [['you', 'cc', 'your prompt', 'you'], ['cc', 'api', 'request', 'req']],
        add: [U('u2', '"Now add the refund endpoint"', 20)],
        d: `The request is far smaller. Claude Code's own instructions and tools at the very start have not changed, so they can still come from the cache, but the conversation part is new and is written to the cache again.`
      },
      {
        t: 'Or compact yourself, with a focus',
        term: [['p', '/compact Keep the API design decisions and the failing test names. Drop the debugging.']],
        pk: [['you', 'cc', '/compact …', 'you'], ['cc', 'api', 'summarise, with your focus', 'req'], ['api', 'cc', 'summary', 'resp']],
        del: ['u2'],
        set: { sum: { label: 'Focused summary', tok: 4500, note: 'kept what you asked for' } },
        d: `Run <code>/compact</code> at a natural break, such as after finishing a feature, and say what to keep. Anything that must survive for certain belongs in a file, such as a plan or progress notes, not only in the chat.`
      }
    ],
    after: `<div class="takeaways"><h3>Remember</h3><ul>
      <li><b>Watch it:</b> <code>/context</code> for the map, <code>/usage</code> for cost and cache hits, and a status line that shows the percentage used (<code>/statusline</code> sets one up).</li>
      <li><b>One task per conversation.</b> <code>/clear</code> between tasks beats compacting a muddled one.</li>
      <li><b>Compact on purpose,</b> at milestones and with a focus, rather than waiting for auto-compact mid-task.</li>
      <li><b>Write durable state to files.</b> Plans, to-do lists and progress notes survive anything. The <a href="/harness">Harness engineering lab</a> shows why.</li>
      <li><b>Send big reading to subagents</b> so it never enters the main window.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 11
  {
    id: 'rewind', short: '/clear, rewind, resume', title: '/clear, rewind and resume',
    sub: 'Start fresh, undo, and pick up where you left off',
    nodes: ['you', 'cc', 'api', 'files'],
    init: [SYS, TOOLS, ENV, MEM, B('p1', 'msg', 'Prompt 1: "Add input validation"', 30, 'checkpoint 1'), B('w1', 'tool', "Claude's work: 2 files edited", 14000), B('p2', 'msg', 'Prompt 2: "Refactor the validator into a class"', 30, 'checkpoint 2'), B('w2', 'tool', "Claude's work: 5 files edited, tests broken", 22000)],
    warm: true,
    term0: [['p', 'Add input validation'], ['say', 'Added validation to the signup and profile forms.'], ['p', 'Refactor the validator into a class'], ['say', 'Refactored into a Validator class across 5 files.'], ['bad', '7 tests failing']],
    steps: [
      {
        t: 'Every prompt is a checkpoint',
        on: ['cc', 'files'],
        d: `Claude Code saves a checkpoint each time you send a prompt, and snapshots files before its edit tools change them. Here the second prompt went somewhere you do not want.`
      },
      {
        t: 'Esc Esc opens the rewind menu',
        term: [['sys', '(Esc Esc)'], ['box', 'Rewind to before:\n  Prompt 1: "Add input validation"\n❯ Prompt 2: "Refactor the validator into a class"']],
        pk: [['you', 'cc', 'Esc Esc', 'you']],
        d: `Press <span class="kbd">Esc</span> twice with an empty prompt, or type <code>/rewind</code>. Pick the prompt to go back to, then choose what to restore:`,
        extra: `<div class="cols">
          <div class="mini"><b>Restore code and conversation</b>Both go back to that point.</div>
          <div class="mini"><b>Restore conversation</b>Forget the chat after it; keep the files as they are now.</div>
          <div class="mini"><b>Restore code</b>Put the files back; keep the chat, so Claude remembers what did not work.</div>
          <div class="mini"><b>Summarize from here / up to here</b>Replace part of the conversation with a summary, to free space without losing the gist.</div>
        </div>`
      },
      {
        t: 'Restore code and conversation',
        pk: [['cc', 'files', 'restore 5 files', 'tool'], ['files', 'cc', 'restored', 'file']],
        del: ['p2', 'w2'],
        term: [['ok', 'Restored code and conversation to before prompt 2']],
        tags: [['good', 'files restored']],
        d: `The files go back to how they were, and the conversation after that point is removed from the context. Rewinding does not break the prompt cache for what came before.`
      },
      {
        t: 'What rewind cannot undo',
        term: [['tool', 'Bash(rm -rf build/ && npm run db:migrate)']],
        tags: [['warn', 'not tracked']],
        on: ['files'],
        d: `Checkpoints only track edits made by Claude's file-editing tools. Files changed by shell commands such as <code>rm</code>, <code>mv</code> or a database migration are not restored. Neither are edits you make outside Claude Code, or edits by most subagents.`,
        why: `Checkpoints are a quick local undo, not version control. Commit before big changes, and keep using git.`
      },
      {
        t: '/clear: a fresh conversation',
        term: [['p', '/clear']],
        pk: [['you', 'cc', '/clear', 'you'], ['files', 'cc', 'CLAUDE.md, read again', 'file']],
        del: ['p1', 'w1'],
        set: { mem: { note: 're-read from disk' } },
        d: `Use <code>/clear</code> when you move to a different task. The conversation is emptied and CLAUDE.md is read again, so the next request starts small and focused. Your files are not touched, and the old conversation is still saved.`
      },
      {
        t: 'Resume later',
        term: [['sh', 'claude --continue'], ['sys', '(or claude --resume, or /resume inside a session)']],
        pk: [['files', 'cc', 'saved session', 'file']],
        add: [B('old', 'msg', 'The earlier conversation, restored', 36000, 'loaded from the saved session')],
        d: `Sessions are saved on your machine as you go. <code>claude --continue</code> picks up the most recent one; <code>claude --resume</code> or <code>/resume</code> lets you choose. Name a session with <code>claude -n auth-investigation</code> or <code>/rename</code>, then come back to it with <code>claude --resume auth-investigation</code>. <code>--fork-session</code> (with <code>--resume</code> or <code>--continue</code>) or <code>/branch</code> copies a session, so you can try two approaches from the same analysis without changing the original. Checkpoints survive resuming.`,
        why: `Resume when what Claude read is still true. If the files have changed since, either tell the resumed session exactly which files changed so it re-reads only those, or start fresh with a short summary of the findings: stale tool results are worse than none.`
      }
    ],
    after: `<div class="table-wrap"><table class="t"><thead><tr><th>Command</th><th>Conversation</th><th>Your files</th><th>Use it when</th></tr></thead><tbody>
      <tr><td><span class="kbd">Esc</span></td><td>Kept; Claude stops mid-turn</td><td>Kept</td><td>Claude is heading the wrong way. Then say what you want instead.</td></tr>
      <tr><td><code>/rewind</code>, <span class="kbd">Esc Esc</span></td><td>Back to a chosen prompt, or summarised</td><td>Optionally restored</td><td>An attempt went badly and you want to try again</td></tr>
      <tr><td><code>/compact</code></td><td>Replaced by a summary</td><td>Kept</td><td>Same task, but the context is getting full</td></tr>
      <tr><td><code>/clear</code></td><td>Emptied; the old one is saved</td><td>Kept</td><td>You are starting a different task</td></tr>
      <tr><td><code>/resume</code>, <code>--continue</code></td><td>A saved one is loaded</td><td>Kept</td><td>You want to carry on yesterday's work</td></tr>
      <tr><td><code>--resume name --fork-session</code></td><td>A copy of a saved one</td><td>Kept</td><td>You want to try a second approach from the same starting point</td></tr>
    </tbody></table></div>
    <p class="small muted">The Agent SDK has the same controls: the <code>resume</code> option takes a session id, <code>fork_session=True</code> (<code>forkSession</code> in TypeScript) branches it, and <code>continue_conversation=True</code> picks up the most recent session.</p>`
  },

  // ------------------------------------------------------------------ 12
  {
    id: 'permissions', short: 'Permissions & modes', title: 'Permissions and modes',
    sub: 'Who decides whether a tool call runs', noCtx: true,
    nodes: ['you', 'cc', 'api', 'files', 'hooks'],
    gates: ['Hooks', 'Deny rules', 'Ask rules', 'Allow rules', 'Mode', 'You'],
    steps: [
      {
        t: 'Rules live in settings files',
        term: [['sys', '(.claude/settings.json, committed with the project)']],
        on: ['files'],
        d: `Before any tool call runs, Claude Code checks it against hooks, then your permission rules, then the current mode, and only then asks you. Rules are written per tool, such as <code>Bash(npm run test *)</code> for any command that starts with those words.`,
        extra: `<pre class="code"><code>{
"permissions": {
  "deny":  ["Read(./.env)", "Bash(rm -rf *)"],
  "ask":   ["Bash(git push *)"],
  "allow": ["Bash(npm run test *)", "Bash(git diff *)"]
}
}</code></pre><p class="small muted" style="margin:0">Settings files, strongest first: managed policy, command-line flags, <code>.claude/settings.local.json</code>, <code>.claude/settings.json</code>, <code>~/.claude/settings.json</code>.</p>`
      },
      {
        t: 'npm run test: allowed by a rule',
        term: [['tool', 'Bash(npm run test)'], ['out', '45 passed']],
        pk: [['api', 'cc', 'Bash(npm run test)', 'resp'], ['cc', 'hooks', 'PreToolUse', 'hook'], ['hooks', 'cc', 'exit 0', 'hook'], ['cc', 'files', 'run', 'tool']],
        gates: { at: 3, label: 'match', verdict: 'allow' },
        tags: [['good', 'runs without asking']],
        d: `No hook objected, no deny or ask rule matched, and an allow rule did. The command runs without a prompt.`
      },
      {
        t: 'Reading .env: denied',
        term: [['tool', 'Read(.env)'], ['bad', 'Permission denied by your settings']],
        pk: [['api', 'cc', 'Read(.env)', 'resp'], ['cc', 'api', 'denied', 'bad']],
        gates: { at: 1, label: 'match', verdict: 'deny' },
        tags: [['bad', 'blocked']],
        d: `Deny rules are checked first and always win. A narrower allow rule cannot carve an exception out of a broad deny. Claude is told the call was denied and carries on without it.`
      },
      {
        t: 'git push: an ask rule',
        term: [['tool', 'Bash(git push origin feature/refunds)'], ['ask', 'Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently']],
        pk: [['api', 'cc', 'Bash(git push …)', 'resp'], ['cc', 'you', 'allow?', 'you']],
        gates: { at: 2, label: 'match', verdict: 'ask' },
        d: `Ask rules are checked before allow rules, so they make Claude Code ask you even when an allow rule also matches. Use them for actions that reach outside your machine.`
      },
      {
        t: 'Editing a file: no rule matches, so the mode decides',
        term: [['sys', '⏵⏵ accept edits on (shift+tab to cycle)'], ['tool', 'Update(src/refunds.ts)'], ['out', 'Updated src/refunds.ts with 9 additions']],
        pk: [['api', 'cc', 'Edit src/refunds.ts', 'resp'], ['cc', 'files', 'edit', 'tool']],
        gates: { at: 4, label: 'acceptEdits', verdict: 'allow' },
        d: `<span class="kbd">Shift+Tab</span> cycles the permission modes. In the default mode this edit would ask you. In accept-edits mode, file edits go ahead without asking.`,
        extra: `<div class="table-wrap"><table class="t"><tbody>
          <tr><td><code>default</code></td><td>Asks before edits and most commands. Shown as Manual.</td></tr>
          <tr><td><code>acceptEdits</code></td><td>File edits go ahead; commands still follow your rules.</td></tr>
          <tr><td><code>plan</code></td><td>Claude reads and plans but changes nothing until you approve the plan.</td></tr>
          <tr><td><code>auto</code></td><td>A second model reviews each action instead of asking you. Where available, recent versions start in it.</td></tr>
          <tr><td><code>dontAsk</code></td><td>Never prompts: anything your rules do not allow is refused.</td></tr>
          <tr><td><code>bypassPermissions</code></td><td>No checks at all. Only for throwaway containers and VMs.</td></tr>
        </tbody></table></div>`
      },
      {
        t: 'Plan mode: look first, change nothing',
        term: [['sys', '⏸ plan mode on (shift+tab to cycle)'], ['p', 'Move auth to the new session library'], ['tool', 'Read(src/auth/session.ts)'], ['tool', 'Bash(grep -rn "getSession" src/)'], ['say', 'Plan: 1. Add the library behind an adapter. 2. Switch the 6 call sites. 3. Remove the old code. 4. Run the auth tests.'], ['ask', 'Would you like to proceed?\n❯ 1. Yes, and auto-accept edits\n  2. Yes, and manually approve edits\n  3. No, keep planning']],
        pk: [['you', 'cc', 'prompt in plan mode', 'you'], ['cc', 'api', 'request', 'req'], ['api', 'cc', 'reads + plan', 'resp'], ['cc', 'you', 'approve the plan?', 'you']],
        gates: { at: 4, label: 'plan: read only', verdict: 'ask' },
        d: `In plan mode Claude can read and search but not edit. It explores, writes a plan and waits for you. Correcting a plan costs a sentence; correcting a wrong implementation costs much more.`
      },
      {
        t: 'The sandbox: a hard boundary for shell commands',
        term: [['p', '/sandbox'], ['ok', 'Sandbox enabled for Bash commands']],
        pk: [['you', 'cc', '/sandbox', 'you']],
        on: ['files'],
        d: `<code>/sandbox</code> runs shell commands inside an operating-system sandbox that limits which files and network hosts they can reach, on macOS, Linux and WSL2. It covers shell commands only, not file tools, MCP servers or hooks. With it on, you can allow more commands without approving each one.`
      }
    ],
    after: `<div class="takeaways"><h3>Remember</h3><ul>
      <li><b>Order:</b> hooks, then deny, ask and allow rules, then the mode, then you. Deny always wins.</li>
      <li><b>Allow the safe and frequent</b> (tests, linters, <code>git diff</code>) so prompts stay rare enough that people read them.</li>
      <li><b>Commit team rules</b> in <code>.claude/settings.json</code>; keep personal ones in <code>.claude/settings.local.json</code>.</li>
      <li><b>Use plan mode for anything non-trivial,</b> and the sandbox when you want Claude to run commands freely.</li>
      <li><code>/permissions</code> shows and edits the rules. The bundled <code>/fewer-permission-prompts</code> skill suggests safe ones from your history.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 13
  {
    id: 'ci', short: 'Headless & CI', title: 'Claude Code in CI: no terminal, nobody to ask',
    sub: 'claude -p on a build server, with findings a script can post',
    nodes: ['you', 'cc', 'api', 'files'],
    nodeSub: { you: 'the CI job', cc: 'claude -p on the runner', files: 'the checked-out repo' },
    init: [SYS, TOOLS, ENV],
    steps: [
      {
        t: 'claude -p: one run, then exit',
        term: [['sh', 'claude -p "Review the changes on this branch" --output-format json']],
        pk: [['you', 'cc', 'claude -p "…"', 'you']],
        d: `<code>-p</code> (or <code>--print</code>) runs one task with no interactive interface and exits: 0 on success, non-zero on failure. Without it a pipeline would sit waiting for someone to type at a prompt that nobody can see.`
      },
      {
        t: 'Nobody can approve a prompt',
        term: [['sh', '--allowedTools "Read,Grep,Glob,Bash(git diff *)" --permission-mode dontAsk --max-turns 20']],
        on: ['cc'],
        tags: [['warn', 'decide permissions up front']],
        d: `In CI there is nobody to press Yes. Allow the read-only tools the review needs, and use <code>dontAsk</code> so anything else is refused rather than waited on. <code>--max-turns</code> caps the run. Servers in a project <code>.mcp.json</code> load without the approval prompt in print mode, so review that file as carefully as the workflow.`
      },
      {
        t: 'CLAUDE.md is the briefing for every run',
        pk: [['files', 'cc', 'CLAUDE.md, rules', 'file']],
        add: [B('cimem', 'mem', 'CLAUDE.md files', 1500, 'review criteria, test standards, fixtures')],
        d: `A CI run reads the same CLAUDE.md and rules as you do. That is where the review criteria belong (report bugs and security problems; skip style the linter already handles), with the testing standards and the fixtures that exist, so every run applies the same rules.`
      },
      {
        t: 'Reading the change',
        term: [['tool', 'Bash(git diff origin/main...HEAD)'], ['out', '6 files changed, 214 insertions(+), 37 deletions(-)']],
        pk: [['cc', 'api', 'request', 'req'], ['api', 'cc', 'Bash(git diff …)', 'resp'], ['cc', 'files', 'run', 'tool']],
        call: true,
        add: [T('cidiff', 'git diff: 6 files', 4200, 'the change under review')],
        d: `The agent loop works exactly as it does in your terminal: Claude asks for tools, Claude Code runs the allowed ones and sends the results back.`
      },
      {
        t: 'Findings in a fixed shape',
        term: [['sh', '--json-schema "$(cat review-schema.json)"'], ['out', '{ "structured_output": { "findings": [ { "file": "src/refunds.ts", "line": 42, "severity": "bug", "status": "new", … } ] } }']],
        pk: [['api', 'cc', 'findings', 'resp'], ['cc', 'you', 'JSON', 'you']],
        call: true,
        resp: [C('cires', 'findings as JSON', 600, 'checked against the schema')],
        tags: [['good', 'machine-readable']],
        d: `With <code>--output-format json</code> and <code>--json-schema</code>, the validated result arrives in the <code>structured_output</code> field. A script turns each finding into a pull request comment. If the run ends without valid output the field is missing, so fail the job rather than post nothing.`
      },
      {
        t: 'A fresh reviewer, not the author',
        on: ['cc', 'api'],
        why: `The session that wrote the code keeps its own reasoning, so it tends to agree with itself. Asking it to "review carefully" or to think longer does not fix that.`,
        d: `Review in a separate <code>claude -p</code> run, which has none of the writing session's history. Inside one session, a reviewer subagent does the same job: it starts with an empty context.`
      },
      {
        t: 'Large change: one pass per file, then one across files',
        term: [['sh', 'for f in $(git diff --name-only origin/main...HEAD); do claude -p "Review $f only" …; done'], ['sh', 'claude -p "Check how these files work together: …"']],
        d: `Reviewing twenty files at once spreads attention thin and produces contradictory findings. Review each file for local problems, then run one integration pass for data flow between files.`
      },
      {
        t: 'A new commit: report only what is new',
        term: [['p', 'Earlier findings are in previous.json. Report only issues that are new or still not fixed, and mark each one.']],
        pk: [['files', 'cc', 'previous.json', 'file']],
        add: [T('ciprev', 'Earlier findings', 500, 'from the last run')],
        d: `When the pull request is updated, give the next run the earlier findings and ask for new or still-open issues only, each marked <code>new</code> or <code>still_open</code>. Without that, every push repeats the same comments and people stop reading them.`
      },
      {
        t: 'Generating tests: show it the tests you have',
        term: [['p', 'Add tests for src/refunds.ts. The existing tests are in src/refunds.test.ts; do not repeat their scenarios.']],
        d: `For test generation, put the existing test files in context so Claude does not suggest scenarios already covered, and list the fixtures and what makes a valuable test in CLAUDE.md.`
      }
    ],
    after: `<p>The ready-made route is the official GitHub Action, <code>anthropics/claude-code-action@v1</code>, set up by running <code>/install-github-app</code> inside Claude Code. Its <code>prompt</code> input is the task, and <code>claude_args</code> passes any of the flags above. A complete workflow that runs the CLI directly and posts the findings is in <code>examples/claude-code/ci/</code>.</p>
    <div class="takeaways"><h3>Remember</h3><ul>
      <li><code>-p</code> so nothing waits for input; <code>--output-format json</code> with <code>--json-schema</code> for findings a script can read from <code>structured_output</code>.</li>
      <li>Decide permissions up front: <code>--allowedTools</code> for what the job needs, <code>dontAsk</code> for everything else.</li>
      <li>CLAUDE.md carries the review criteria and testing standards into every run.</li>
      <li>Review with a fresh instance, per file then across files, and tell re-runs what was already reported.</li>
    </ul></div>`
  },

  // ------------------------------------------------------------------ 14
  {
    id: 'cheatsheet', short: 'Cheat sheet', title: 'Cheat sheet', sub: '', static: true, nodes: [], steps: [],
    after: `<h2 style="margin-top:6px">14. Cheat sheet</h2>
    <p>Everything from the talk on one page.</p>
    <div class="sheet">
      <div class="table-wrap"><table class="t"><thead><tr><th>Command</th><th>What it does</th></tr></thead><tbody>
        <tr><td><code>/init</code></td><td>Draft a CLAUDE.md from the codebase, or suggest improvements</td></tr>
        <tr><td><code>/memory</code></td><td>Open CLAUDE.md files and rules; turn auto memory on or off</td></tr>
        <tr><td><code>/context</code></td><td>Map of what fills the context window</td></tr>
        <tr><td><code>/compact [focus]</code></td><td>Summarise the conversation to free space</td></tr>
        <tr><td><code>/clear</code></td><td>Start a new conversation</td></tr>
        <tr><td><code>/rewind</code></td><td>Go back to an earlier prompt: code, conversation or both</td></tr>
        <tr><td><code>/resume</code></td><td>Pick a saved session to continue</td></tr>
        <tr><td><code>/rename name</code></td><td>Name this session, to resume it by name later</td></tr>
        <tr><td><code>/plan</code></td><td>Switch to plan mode from the prompt</td></tr>
        <tr><td><code>/agents</code></td><td>Custom subagents in <code>.claude/agents/</code></td></tr>
        <tr><td><code>/ide</code></td><td>Connect a terminal session to VS Code or a JetBrains IDE</td></tr>
        <tr><td><code>/model</code></td><td>Switch model and effort (misses the cache once)</td></tr>
        <tr><td><code>/usage</code></td><td>Cost, plan limits and cache hit rate. <code>/cost</code> is an alias.</td></tr>
        <tr><td><code>/mcp</code></td><td>MCP server status and sign-in</td></tr>
        <tr><td><code>/plugin</code></td><td>Browse, install and manage plugins</td></tr>
        <tr><td><code>/hooks</code></td><td>List configured hooks and where they come from</td></tr>
        <tr><td><code>/permissions</code></td><td>Allow, ask and deny rules</td></tr>
        <tr><td><code>/sandbox</code></td><td>Sandbox shell commands</td></tr>
        <tr><td><code>/code-review</code></td><td>Review your changes for bugs</td></tr>
      </tbody></table></div>
      <div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Key or syntax</th><th>What it does</th></tr></thead><tbody>
          <tr><td><span class="kbd">Esc</span></td><td>Stop Claude, keeping the work so far</td></tr>
          <tr><td><span class="kbd">Esc</span> <span class="kbd">Esc</span></td><td>Rewind, when the prompt is empty</td></tr>
          <tr><td><span class="kbd">Shift+Tab</span></td><td>Cycle permission modes, including plan mode</td></tr>
          <tr><td><span class="kbd">Ctrl+B</span></td><td>Send a running task to the background</td></tr>
          <tr><td><code>! command</code></td><td>Run a shell command; its output joins the conversation</td></tr>
          <tr><td><code>@path</code></td><td>Point Claude at a file, with autocomplete</td></tr>
          <tr><td><code>/name</code></td><td>Run a command or skill</td></tr>
          <tr><td><code>claude -c</code>, <code>claude -r [name]</code></td><td>Continue the last session, or resume one by name or id</td></tr>
          <tr><td><code>--fork-session</code></td><td>With <code>-r</code> or <code>-c</code>: branch a copy instead of continuing it</td></tr>
          <tr><td><code>--permission-mode plan</code></td><td>Start in plan mode</td></tr>
          <tr><td><code>claude -p "…"</code></td><td>Run once without the interactive UI, for scripts and ${go('ci', 'CI')}</td></tr>
          <tr><td><code>--output-format json --json-schema '…'</code></td><td>With <code>-p</code>: output validated against a schema, in <code>structured_output</code></td></tr>
        </tbody></table></div>
        <div class="table-wrap" style="margin-top:12px"><table class="t"><thead><tr><th>You want to…</th><th>Use</th></tr></thead><tbody>
          <tr><td>Tell Claude facts it needs every time</td><td>${go('request', 'CLAUDE.md')}</td></tr>
          <tr><td>Teach a procedure, or save a prompt</td><td>${go('skills', 'A skill')}</td></tr>
          <tr><td>Make something always or never happen</td><td>${go('hooks', 'A hook')} or a ${go('permissions', 'permission rule')}</td></tr>
          <tr><td>Reach an outside system</td><td>${go('mcp', 'An MCP server')}</td></tr>
          <tr><td>Keep heavy reading out of your context</td><td>${go('subagents', 'A subagent')}</td></tr>
          <tr><td>Give the whole team the same setup</td><td>${go('plugins', 'A plugin')}, or commit <code>.claude/</code></td></tr>
          <tr><td>Review every pull request</td><td>${go('ci', '<code>claude -p</code> in CI')}</td></tr>
        </tbody></table></div>
      </div>
    </div>
    <div class="takeaways"><h3>A workflow that works</h3><ul>
      <li><b>Explore, plan, then code.</b> Use plan mode, read the plan, then let Claude implement it.</li>
      <li><b>Give Claude a way to verify:</b> tests, a linter, a script, or a Stop hook that runs them.</li>
      <li><b>One task per conversation.</b> <code>/clear</code> between tasks, <code>/compact</code> at milestones.</li>
      <li><b>Be specific.</b> Name the files, the constraint and what done looks like.</li>
      <li><b>Correct early.</b> <span class="kbd">Esc</span> as soon as it heads the wrong way; rewind when an attempt fails.</li>
      <li><b>Commit the shared setup:</b> <code>CLAUDE.md</code>, <code>.claude/settings.json</code>, <code>.claude/skills/</code>, <code>.claude/agents/</code> and <code>.mcp.json</code>. Keep <code>CLAUDE.local.md</code> and <code>.claude/settings.local.json</code> out of git.</li>
    </ul></div>
    <h3>Further reading</h3>
    <p class="small" style="margin:0 0 4px">Start with <a href="https://code.claude.com/docs/en/how-claude-code-works.md" target="_blank" rel="noopener">How Claude Code works</a>. The pages each chapter was checked against:</p>
    <ul class="bp small"><li><a href="https://code.claude.com/docs/en/how-claude-code-works.md" target="_blank" rel="noopener">How Claude Code works</a>: the agent loop, tools and sessions</li><li><a href="https://code.claude.com/docs/en/memory" target="_blank" rel="noopener">Memory</a>: CLAUDE.md, rules, imports and auto memory</li><li><a href="https://code.claude.com/docs/en/context-window" target="_blank" rel="noopener">Context window</a>: what loads at start-up and what survives compaction</li><li><a href="https://code.claude.com/docs/en/prompt-caching" target="_blank" rel="noopener">Prompt caching</a>: what keeps or breaks the cache</li><li><a href="https://code.claude.com/docs/en/tools-reference" target="_blank" rel="noopener">Tools reference</a>: how Read, Edit, Write and Bash behave</li><li><a href="https://code.claude.com/docs/en/skills" target="_blank" rel="noopener">Skills</a></li><li><a href="https://code.claude.com/docs/en/hooks" target="_blank" rel="noopener">Hooks reference</a></li><li><a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noopener">MCP</a></li><li><a href="https://code.claude.com/docs/en/plugins/overview" target="_blank" rel="noopener">Plugins</a></li><li><a href="https://code.claude.com/docs/en/sub-agents" target="_blank" rel="noopener">Subagents</a></li><li><a href="https://code.claude.com/docs/en/checkpointing" target="_blank" rel="noopener">Checkpointing</a>: rewind and its limits</li><li><a href="https://code.claude.com/docs/en/permission-modes" target="_blank" rel="noopener">Permission modes</a></li><li><a href="https://code.claude.com/docs/en/permissions" target="_blank" rel="noopener">Permissions</a>: rule syntax and precedence</li><li><a href="https://code.claude.com/docs/en/commands" target="_blank" rel="noopener">Commands</a>: every slash command and bundled skill</li><li><a href="https://code.claude.com/docs/en/headless" target="_blank" rel="noopener">Run Claude Code programmatically</a>: <code>-p</code>, output formats and <code>--json-schema</code></li><li><a href="https://code.claude.com/docs/en/github-actions" target="_blank" rel="noopener">GitHub Actions</a></li><li><a href="https://code.claude.com/docs/en/sessions" target="_blank" rel="noopener">Sessions</a>: naming, resuming and forking</li><li><a href="https://code.claude.com/docs/en/data-usage" target="_blank" rel="noopener">Data usage</a>: what is sent to Anthropic and how long it is kept</li></ul>
    <p class="small muted" style="margin-top:12px">Facts on this page were checked against the Claude Code documentation at code.claude.com on 15 October 2026. Claude Code changes often; the terminal views are simplified and token counts are typical sizes, not measurements. For the files to copy, see the <a href="/claude-code">Claude Code setup lab</a> and <code>examples/claude-code/</code>.</p>`
  }
];

export const CC_CHAPTERS = CHAPTERS;
