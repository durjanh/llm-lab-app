/* The advanced hooks chapter: the rest of the 33 events, played out on one session, with the lifecycle chart lit up
 * at each step. The basic Hooks chapter (claude-code-chapters.js) covers SessionStart, UserPromptSubmit, PreToolUse,
 * PostToolUse and Stop; this one covers everything else. Facts are from code.claude.com/docs/en/hooks, checked on
 * 13 November 2026. The scripts named here are in examples/claude-code/hook-lifecycle/. */
import { lifecycleSvg } from '../claude-code/hookEvents';

const B = (id, k, label, tok, note) => ({ id, k, label, tok, note });
const T = (id, text, tok, note) => B(id, 'tool', text, tok, note);
const SYS = B('sys', 'sys', 'System prompt', 3000, "Claude Code's own instructions");
const TOOLS = B('tools', 'sys', 'Built-in tool definitions', 12000, 'Read, Edit, Write, Bash, Agent, Skill and more');
const ENV = B('env', 'sys', 'Environment', 300, 'working directory, platform, date, git status');
const MEM = B('mem', 'mem', 'CLAUDE.md files', 1500, 'read at start-up, sent with every request');

/** The lifecycle chart, small, with these events lit. */
const LC = (...events) => `<div class="hl-mini" aria-hidden="false">${lifecycleSvg(events, { title: 'Where this happens: ' + events.join(', ') })}</div>`;
const code = (s) => `<pre class="code"><code>${s}</code></pre>`;

export const HOOKS_ADVANCED = {
  id: 'hooks-advanced', short: 'Hooks: advanced', title: 'Hooks, advanced: the whole lifecycle',
  sub: 'The other 28 events, from Setup to SessionEnd, on one session. The chart shows where each one fires.',
  nodes: ['you', 'cc', 'api', 'files', 'hooks', 'sub', 'mcp'], nodeSub: { hooks: '33 events', mcp: 'tickets server', sub: 'code-reviewer' },
  steps: [
    {
      t: 'Setup: once, before any session',
      term: [['sh', 'claude --init-only'], ['hook', 'Setup (init): .claude/hooks/setup-init.sh'], ['out', 'npm ci: added 812 packages in 41s']],
      pk: [['cc', 'hooks', 'Setup: init', 'hook'], ['hooks', 'files', 'npm ci', 'tool'], ['hooks', 'cc', 'exit 0', 'hook']],
      d: `Setup is the only event you have to ask for. It runs with <code>claude --init-only</code>, or <code>--init</code> or <code>--maintenance</code> in <code>-p</code> mode, which is how a CI image or a new laptop gets prepared once rather than on every session. Only command hooks run, they cannot block, and they can leave environment variables for the session in <code>CLAUDE_ENV_FILE</code>.`,
      extra: LC('Setup')
    },
    {
      t: 'Resuming: SessionStart says what changed; InstructionsLoaded says what was read',
      term: [['sh', 'claude --resume payments-db'], ['hook', 'SessionStart (resume): 3 commits on main since you left; the prompt cache has expired'], ['hook', 'InstructionsLoaded: CLAUDE.md (session_start)']],
      pk: [['cc', 'hooks', 'SessionStart: resume', 'hook'], ['hooks', 'cc', 'stdout: 3 new commits', 'hook'], ['cc', 'hooks', 'InstructionsLoaded', 'hook']],
      add: [SYS, TOOLS, ENV, MEM, B('h-res', 'hook', 'SessionStart hook output', 180, '3 commits on main since this session was last used')],
      d: `The matcher tells SessionStart hooks why the session started: <code>startup</code>, <code>resume</code>, <code>clear</code>, <code>compact</code> or <code>fork</code>. On a resume the input also has <code>seconds_since_last_response</code> and <code>prompt_cache_likely_expired</code>, so <code>resume-context.sh</code> only adds what is new. InstructionsLoaded fires for each CLAUDE.md or rules file as it is loaded, with the reason. It can only watch, which is exactly what you want when you are not sure a rule is being read.`,
      extra: LC('SessionStart', 'InstructionsLoaded')
    },
    {
      t: 'You type /deploy. UserPromptExpansion stops it.',
      term: [['p', '/deploy staging'], ['bad', 'UserPromptExpansion hook blocked /deploy: deploys run from main only. You are on feature/payments-db.']],
      pk: [['you', 'cc', '/deploy staging', 'you'], ['cc', 'hooks', 'UserPromptExpansion: deploy', 'hook'], ['hooks', 'cc', 'block: not on main', 'bad']],
      tags: [['bad', 'decision: block']],
      d: `A slash command expands into a prompt before Claude sees it, and this event fires in between. The matcher is the command name. This matters because a PreToolUse hook on the <code>Skill</code> tool only sees skills Claude decides to use, not the ones you type yourself.`,
      extra: LC('UserPromptSubmit', 'UserPromptExpansion') + code(`<span class="c"># deploy-guard.sh (UserPromptExpansion, matcher "deploy")</span>
branch=$(git -C "$CLAUDE_PROJECT_DIR" branch --show-current)
[ "$branch" = main ] &amp;&amp; exit 0
jq -n --arg b "$branch" '{decision: "block",
  reason: "Deploys run from main only. You are on \\($b)."}'`)
    },
    {
      t: 'PermissionRequest answers the dialog for you',
      call: true,
      pk: [['cc', 'api', 'request 1', 'req'], ['api', 'cc', 'tool_use: Bash git status', 'resp'], ['cc', 'hooks', 'PreToolUse', 'hook'], ['cc', 'hooks', 'PermissionRequest', 'hook'], ['hooks', 'cc', 'allow', 'hook'], ['cc', 'files', 'git status', 'tool']],
      resp: [T('t1', 'Claude: Bash git status, git diff', 150), T('r1', 'Results: 2 files changed', 500)],
      term: [['tool', 'Bash(git status)'], ['hook', 'PermissionRequest: allowed by approve-readonly.sh'], ['out', 'On branch feature/payments-db · 2 files changed']],
      d: `PreToolUse runs first, for every call. PermissionRequest runs only when Claude Code is about to show you a permission dialog, and a hook can answer it instead: <code>allow</code> or <code>deny</code> with a message. An allow never overrides a deny rule, and exit code 2 does nothing here, so the answer must be JSON. With no answer, the dialog appears as usual.`,
      extra: LC('PreToolUse', 'PermissionRequest') + code(`{ "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" } } }`)
    },
    {
      t: 'Auto mode says no. PermissionDenied keeps a record.',
      call: true,
      pk: [['cc', 'api', 'request 2', 'req'], ['api', 'cc', 'tool_use: npm publish', 'resp'], ['cc', 'hooks', 'PermissionDenied', 'hook'], ['hooks', 'files', 'append denied.jsonl', 'tool'], ['hooks', 'cc', 'exit 0', 'hook']],
      resp: [T('t2', 'Claude: Bash npm publish --tag next', 80), B('r2', 'bad', 'Result: denied by auto mode', 60, 'publishing is outside the task')],
      term: [['sys', 'auto mode'], ['tool', 'Bash(npm publish --tag next)'], ['bad', 'Denied by auto mode: publishing a package is outside the task'], ['hook', 'PermissionDenied: written to .claude/denied.jsonl']],
      d: `PermissionDenied fires only when auto mode's classifier refuses a call, not for your own "no", deny rules or a PreToolUse block. It cannot reverse the denial. Returning <code>retry: true</code> only tells the model it may try another way. A log of what auto mode refused is the evidence you need before loosening or tightening its rules.`,
      extra: LC('PermissionDenied')
    },
    {
      t: 'An MCP server asks a question: Elicitation and ElicitationResult',
      call: true,
      pk: [['api', 'cc', 'tool_use: tickets create_ticket', 'resp'], ['cc', 'mcp', 'create_ticket', 'mcp'], ['mcp', 'cc', 'asks: priority?', 'mcp'], ['cc', 'hooks', 'Elicitation', 'hook'], ['hooks', 'cc', 'accept: P3', 'hook'], ['mcp', 'cc', 'asks: owner?', 'mcp'], ['cc', 'you', 'form', 'you'], ['you', 'cc', 'jo', 'you'], ['cc', 'hooks', 'ElicitationResult', 'hook'], ['hooks', 'cc', 'on the team: send', 'hook'], ['cc', 'mcp', 'owner: jo', 'mcp']],
      resp: [T('t3', 'Claude: tickets create_ticket (MCP)', 200), T('r3', 'Result: PAY-412 created', 60)],
      term: [['tool', 'tickets - create_ticket (MCP)'], ['hook', 'Elicitation: priority answered P3 by elicitation-defaults.sh'], ['ask', 'tickets asks: Who should own this ticket?\n❯ jo'], ['hook', 'ElicitationResult: "jo" is on the team list; sent']],
      d: `An MCP server can stop in the middle of a tool call to ask for input. An Elicitation hook can answer for you (<code>accept</code> with the content), decline or cancel; with no output you see the form. After you answer, ElicitationResult can check or replace what is about to be sent back to the server, or turn it into a decline.`,
      extra: LC('Elicitation', 'ElicitationResult')
    },
    {
      t: 'A tool fails. PostToolUseFailure suggests another way.',
      call: true,
      pk: [['api', 'cc', 'tool_use: WebFetch', 'resp'], ['cc', 'files', 'WebFetch registry', 'tool'], ['files', 'cc', 'timeout', 'bad'], ['cc', 'hooks', 'PostToolUseFailure', 'hook'], ['hooks', 'cc', 'use the mirror', 'hook']],
      resp: [T('t4', 'Claude: WebFetch registry.npmjs.org', 60), B('r4', 'bad', 'Result: failed, timed out', 40), B('h-fail', 'hook', 'PostToolUseFailure context', 50, 'use https://npm-mirror.internal instead')],
      term: [['tool', 'WebFetch(https://registry.npmjs.org/pg)'], ['bad', 'Error: request timed out'], ['hook', 'PostToolUseFailure: use https://npm-mirror.internal instead']],
      d: `PostToolUse fires only when a call succeeds. A failed call fires PostToolUseFailure instead, with the <code>error</code>. It cannot block anything, but its <code>additionalContext</code> reaches Claude with the failure, so the next attempt can be the right one.`,
      extra: LC('PostToolUse', 'PostToolUseFailure')
    },
    {
      t: 'Four edits at once, one type check: PostToolBatch',
      call: true,
      pk: [['cc', 'api', 'request 4', 'req'], ['api', 'cc', '4 × tool_use: Edit', 'resp'], ['cc', 'hooks', 'PreToolUse × 4', 'hook'], ['cc', 'files', '4 edits', 'tool'], ['cc', 'hooks', 'PostToolUse × 4', 'hook'], ['cc', 'hooks', 'PostToolBatch', 'hook'], ['hooks', 'cc', 'tsc: 1 error', 'hook']],
      resp: [T('t5', 'Claude: Edit 4 files in parallel', 1200), T('r5', 'Results: 4 edits applied', 200), B('h-batch', 'hook', 'PostToolBatch: tsc found 1 error', 120, 'src/db.ts:14 Property "ssl" does not exist')],
      term: [['tool', 'Update(src/db.ts) · Update(src/config.ts) · Update(src/pool.ts) · Update(tests/db.test.ts)'], ['hook', 'PostToolUse ×4: prettier --write'], ['hook', 'PostToolBatch: npx tsc --noEmit · 1 error, src/db.ts:14']],
      d: `When Claude makes several tool calls in one reply, PreToolUse and PostToolUse run for each one, and PostToolBatch runs once when the whole batch is done, before the next model call. That is the place for a check that should run once, like a type check. Its <code>additionalContext</code> is added once. A <code>block</code> here stops the agentic loop altogether, so use context to send errors back, not a block.`,
      extra: LC('PreToolUse', 'PostToolUse', 'PostToolBatch')
    },
    {
      t: 'A subagent starts with extra context, and is sent back once',
      call: true,
      on: ['sub'],
      pk: [['cc', 'hooks', 'SubagentStart: code-reviewer', 'hook'], ['hooks', 'cc', 'review src/payments only', 'hook'], ['cc', 'sub', 'task + context', 'req'], ['sub', 'api', 'review', 'req'], ['api', 'sub', 'findings', 'resp'], ['cc', 'hooks', 'SubagentStop', 'hook'], ['hooks', 'cc', 'block: no file:line', 'bad'], ['cc', 'sub', 'add file:line', 'req'], ['sub', 'cc', '2 findings', 'resp']],
      resp: [T('t6', 'Claude: Agent code-reviewer', 120), T('r6', 'Result: 2 findings with file and line', 400)],
      term: [['tool', 'Agent(code-reviewer)'], ['hook', 'SubagentStart: told to review src/payments only'], ['bad', 'SubagentStop hook: findings have no file:line references; sent back'], ['out', 'code-reviewer: 2 findings, src/db.ts:14 and src/pool.ts:31']],
      tags: [['bad', 'decision: block']],
      d: `The matcher is the agent type. SubagentStart can only add context to the subagent's start. SubagentStop works like Stop for the subagent: a <code>block</code> sends its reason to the subagent as its next instruction. Check <code>stop_hook_active</code> so a hook that keeps failing cannot send it back for ever.`,
      extra: LC('SubagentStart', 'SubagentStop')
    },
    {
      t: 'Tasks: TaskCreated and TaskCompleted hold the line',
      term: [['tool', 'TaskCreate("Update the connection string")'], ['bad', 'TaskCreated hook: task subjects need a ticket number, such as PAY-412'], ['tool', 'TaskCreate("PAY-412 Update the connection string")'], ['tool', 'TaskUpdate(PAY-412, completed)'], ['bad', 'TaskCompleted hook: tests/db.test.ts is still failing; the task stays open']],
      pk: [['cc', 'hooks', 'TaskCreated', 'hook'], ['hooks', 'cc', 'exit 2: no ticket', 'bad'], ['cc', 'hooks', 'TaskCompleted', 'hook'], ['hooks', 'cc', 'exit 2: tests fail', 'bad']],
      tags: [['bad', 'exit code 2']],
      d: `When Claude keeps a task list, TaskCreated fires as each task is made, and exit code 2 deletes it with the reason. TaskCompleted fires as a task is marked done, and exit code 2 keeps it open. Then the amber loop goes round again: the next tool call starts at PreToolUse.`,
      extra: LC('TaskCreated', 'TaskCompleted')
    },
    {
      t: 'The turn ends on an API error: StopFailure, not Stop',
      call: true,
      pk: [['cc', 'api', 'request 6', 'req'], ['api', 'cc', '529 overloaded', 'bad'], ['cc', 'hooks', 'StopFailure: overloaded', 'hook'], ['hooks', 'you', 'notification', 'hook'], ['cc', 'hooks', 'Notification: idle_prompt', 'hook']],
      term: [['bad', 'API Error: 529 overloaded'], ['hook', 'StopFailure (overloaded): stop-failure-notify.sh sent a desktop notification'], ['hook', 'Notification (idle_prompt): Claude is waiting for your input']],
      d: `When a turn ends because of an API error, StopFailure runs instead of Stop, with the error as its matcher (<code>rate_limit</code>, <code>overloaded</code>, <code>billing_error</code> and others). It cannot block or retry, so its job is to tell someone. Notification fires when Claude Code wants your attention: after about a minute idle, or when it needs a permission.`,
      extra: LC('Stop', 'StopFailure', 'Notification')
    },
    {
      t: 'In an agent team: TeammateIdle keeps a teammate going',
      pk: [['cc', 'hooks', 'TeammateIdle: tester', 'hook'], ['hooks', 'cc', 'exit 2: 2 unclaimed tasks', 'bad']],
      term: [['hook', 'TeammateIdle (tester): 2 tasks are still unclaimed, keep going']],
      tags: [['bad', 'exit code 2']],
      d: `With agent teams, several Claude Code sessions share a task list. TeammateIdle fires when a teammate is about to stop. Exit code 2 sends it back to work with the reason; <code>continue: false</code> stops it for good.`,
      extra: LC('TeammateIdle')
    },
    {
      t: 'The context fills up: PreCompact steers the summary',
      call: true,
      pk: [['cc', 'hooks', 'PreCompact: auto', 'hook'], ['hooks', 'cc', 'keep files + failing tests', 'hook'], ['cc', 'api', 'summarise', 'req'], ['api', 'cc', 'summary', 'resp'], ['cc', 'hooks', 'PostCompact', 'hook'], ['cc', 'hooks', 'SessionStart: compact', 'hook']],
      del: ['t1', 'r1', 't2', 'r2', 't3', 'r3', 't4', 'r4', 'h-fail', 't5', 'r5', 'h-batch', 't6', 'r6'],
      add: [B('sum', 'sum', 'Summary of the conversation so far', 2400, 'kept: changed files and the failing test (PreCompact instructions)')],
      term: [['sys', 'Auto-compacting conversation…'], ['hook', 'PreCompact (auto): keep the list of changed files and failing tests'], ['hook', 'PostCompact: summary saved to .claude/compactions/'], ['hook', 'SessionStart (compact): open tickets added again']],
      d: `Whatever a PreCompact hook prints becomes extra instructions for the summary, so the things you care about survive. A <code>block</code> stops compaction. PostCompact gets the finished summary and can only read it. Then SessionStart runs again with <code>compact</code>, which is how context lost in the summary comes back.`,
      extra: LC('PreCompact', 'PostCompact', 'SessionStart')
    },
    {
      t: 'Around the edges: settings, models, worktrees, files and the screen',
      term: [
        ['bad', 'ConfigChange hook blocked a change to .claude/settings.json: it removed the project hooks'],
        ['hook', 'PreModelSwitch (opus): asking first, the switch rewrites a warm prompt cache'],
        ['hook', 'PostModelSwitch: logged sonnet → opus'],
        ['hook', 'FileChanged (.envrc): DATABASE_URL reloaded'],
        ['hook', 'WorktreeCreate: /repo/.worktrees/bold-oak-a3f2, with .env.local copied'],
        ['hook', 'MessageDisplay: masked sk-ant-… on screen']
      ],
      pk: [['cc', 'hooks', 'ConfigChange', 'hook'], ['hooks', 'cc', 'block', 'bad'], ['cc', 'hooks', 'PreModelSwitch', 'hook'], ['hooks', 'cc', 'ask', 'hook'], ['cc', 'hooks', 'FileChanged', 'hook'], ['cc', 'hooks', 'WorktreeCreate', 'hook'], ['hooks', 'cc', 'path', 'hook'], ['cc', 'hooks', 'MessageDisplay', 'hook']],
      d: `The events on the left of the chart are not tied to a turn. ConfigChange can block a settings change made mid-session. PreModelSwitch can allow, deny or ask before a switch you asked for, using <code>prompt_cache_warm</code> and <code>estimated_cache_write_usd</code>. CwdChanged, FileChanged and DirectoryAdded follow the environment. WorktreeCreate and WorktreeRemove replace git when a worktree is needed. MessageDisplay changes only what is on screen; Claude and the transcript keep the original.`,
      extra: LC('ConfigChange', 'PreModelSwitch', 'PostModelSwitch', 'WorktreeCreate', 'WorktreeRemove', 'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay')
    },
    {
      t: 'SessionEnd, and the dashed line back',
      pk: [['you', 'cc', '/exit', 'you'], ['cc', 'hooks', 'SessionEnd: prompt_input_exit', 'hook'], ['hooks', 'files', 'usage.jsonl', 'tool']],
      term: [['p', '/exit'], ['hook', 'SessionEnd (prompt_input_exit): usage line written']],
      d: `SessionEnd cannot stop the session ending, and all SessionEnd hooks share 1.5 seconds unless one sets its own timeout, so keep it to a quick write. When you resume later, the dashed line on the chart takes you back to SessionStart with <code>resume</code>.`,
      extra: LC('SessionEnd', 'SessionStart')
    }
  ],
  after: `<div class="grid2">
    <div><h3 style="margin-top:0">The whole lifecycle</h3>${lifecycleSvg([], { title: 'The Claude Code hook lifecycle: 33 events' })}
      <p class="small">Pick any event on the chart in <a href="/claude-code#lifecycle">Claude Code setup</a> for its matcher, input, exit code 2 and JSON output.</p></div>
    <div><h3 style="margin-top:0">The scripts</h3>
      <p class="small">All in <code>examples/claude-code/hook-lifecycle/</code>, with a settings file that wires them up and tests that feed each one its event's JSON.</p>
      <div class="table-wrap"><table class="t"><tbody>
        <tr><td><code>log-event.sh</code></td><td>Every event (except WorktreeCreate and MessageDisplay) to <code>.claude/hook-log.jsonl</code>; <code>trace.py</code> prints the order they really fired in</td></tr>
        <tr><td><code>setup-init.sh</code></td><td>Setup: install dependencies once</td></tr>
        <tr><td><code>resume-context.sh</code></td><td>SessionStart on resume: commits since you left</td></tr>
        <tr><td><code>deploy-guard.sh</code></td><td>UserPromptExpansion: /deploy only from main</td></tr>
        <tr><td><code>approve-readonly.sh</code></td><td>PermissionRequest: allow read-only git, deny curl into a shell</td></tr>
        <tr><td><code>denied-audit.sh</code></td><td>PermissionDenied: keep a record</td></tr>
        <tr><td><code>elicitation-defaults.sh</code>, <code>elicitation-check.sh</code></td><td>Elicitation and ElicitationResult</td></tr>
        <tr><td><code>failure-hint.sh</code></td><td>PostToolUseFailure: suggest the mirror</td></tr>
        <tr><td><code>batch-typecheck.sh</code></td><td>PostToolBatch: one type check per batch</td></tr>
        <tr><td><code>review-scope.sh</code>, <code>review-needs-refs.sh</code></td><td>SubagentStart and SubagentStop</td></tr>
        <tr><td><code>task-ticket.sh</code>, <code>task-tests.sh</code></td><td>TaskCreated and TaskCompleted</td></tr>
        <tr><td><code>stop-failure-notify.sh</code></td><td>StopFailure: tell someone</td></tr>
        <tr><td><code>teammate-idle.sh</code></td><td>TeammateIdle: keep going while tasks are open</td></tr>
        <tr><td><code>pre-compact.sh</code></td><td>PreCompact: what the summary must keep</td></tr>
        <tr><td><code>config-guard.sh</code></td><td>ConfigChange: keep the project hooks</td></tr>
        <tr><td><code>model-switch-guard.sh</code></td><td>PreModelSwitch: ask before throwing away a warm cache</td></tr>
        <tr><td><code>envrc-reload.sh</code></td><td>FileChanged: reload simple <code>export</code> lines</td></tr>
        <tr><td><code>worktree-create.sh</code>, <code>worktree-remove.sh</code></td><td>Worktrees that also copy the files listed in <code>.worktreeinclude</code></td></tr>
        <tr><td><code>mask-secrets.sh</code></td><td>MessageDisplay: mask keys on screen</td></tr>
      </tbody></table></div></div>
  </div>
  <div class="takeaways"><h3>Remember</h3><ul>
    <li><b>Know which events can block.</b> Exit code 2 is ignored on PermissionRequest, PermissionDenied, StopFailure, Notification, InstructionsLoaded and the other observe-only events.</li>
    <li><b>Decisions go in <code>hookSpecificOutput</code></b> with <code>hookEventName</code>, except the top-level <code>decision: "block"</code> that several events use.</li>
    <li><b>Once per call or once per batch:</b> PostToolUse for each file, PostToolBatch for a check that should run once.</li>
    <li><b>Guard the loops.</b> Stop and SubagentStop give <code>stop_hook_active</code>; a FileChanged hook must not rewrite the file it watches.</li>
  </ul></div>`
};
