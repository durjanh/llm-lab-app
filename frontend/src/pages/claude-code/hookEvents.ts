/* The full Claude Code hook lifecycle: all 33 events, where each one sits in a session, and what a hook on it can do.
   One source for the clickable chart on /claude-code and the advanced hooks chapter on /claude-code-inside.
   Facts are from the hooks reference (code.claude.com/docs/en/hooks), checked on 13 November 2026. The layout follows
   the reference's lifecycle diagram. */
import './hook-lifecycle.css';

export type HookEvent = {
  name: string;
  when: string; // when it fires
  matcher: string; // what the matcher is compared with, or that it takes none
  input: string; // the fields that matter, beyond session_id, transcript_path, cwd and hook_event_name
  exit2: string; // what exit code 2 does
  json: string; // what JSON on standard output can decide
  use: string; // a typical use
};

const E = (
  name: string,
  when: string,
  matcher: string,
  input: string,
  exit2: string,
  json: string,
  use: string,
): HookEvent => ({ name, when, matcher, input, exit2, json, use });

const NO_BLOCK = 'Cannot block.';

export const HOOK_EVENTS: HookEvent[] = [
  E(
    'Setup',
    'Only when you ask for it: claude --init-only, or --init or --maintenance with -p.',
    'init or maintenance',
    'trigger',
    'Cannot block; the exit code is ignored.',
    'None. Only command hooks run, and they can write environment variables to CLAUDE_ENV_FILE.',
    'Install dependencies once when a CI image or a new machine is prepared.',
  ),
  E(
    'SessionStart',
    'When a session begins or resumes.',
    'startup, resume, clear, compact or fork',
    'source, model; on resume also seconds_since_last_response and prompt_cache_likely_expired',
    'Cannot block; standard error is shown to you.',
    'additionalContext (plain standard output also becomes context), sessionTitle, watchPaths.',
    'Add the open tickets, or what changed in git since the session was last used.',
  ),
  E(
    'UserPromptSubmit',
    'When you submit a prompt, before Claude sees it.',
    'No matcher',
    'prompt',
    'Blocks the prompt; standard error is the reason.',
    'decision: "block" with a reason; additionalContext. It cannot rewrite the prompt.',
    'Refuse prompts that contain a secret; add the current ticket.',
  ),
  E(
    'UserPromptExpansion',
    'When a command you typed (a slash command or an MCP prompt) expands into a prompt, before it reaches Claude.',
    'The command name',
    'expansion_type, command_name, command_args, prompt',
    'Blocks the expansion.',
    'decision: "block" with a reason; additionalContext.',
    'Stop /deploy outside the main branch. A PreToolUse hook on the Skill tool misses commands you type.',
  ),
  E(
    'PreToolUse',
    'Before a tool call runs.',
    'Tool name: Bash, Edit|Write, mcp__github__.*',
    'tool_name, tool_input, tool_use_id',
    'Blocks the call; standard error goes to Claude as the reason.',
    'permissionDecision: allow, deny, ask or defer; updatedInput replaces the input; additionalContext. deny wins over defer, ask and allow. allow never overrides a deny rule.',
    'Block edits to protected files; force a prompt for git push.',
  ),
  E(
    'PermissionRequest',
    'When Claude Code is about to ask you for permission.',
    'Tool name',
    'tool_name, tool_input, permission_suggestions',
    'Ignored: the dialog still appears.',
    'decision.behavior: allow (optionally with updatedInput or updatedPermissions) or deny (with a message).',
    'Approve read-only commands for you; deny piping a download into a shell.',
  ),
  E(
    'PermissionDenied',
    'When auto mode denies a tool call. Not for your own denials, deny rules or PreToolUse blocks.',
    'Tool name',
    'tool_name, tool_input, reason',
    NO_BLOCK,
    'retry: true tells the model it may try again. The denial stands.',
    'Keep an audit of what auto mode refused.',
  ),
  E(
    'Elicitation',
    'When an MCP server asks you for input in the middle of a tool call.',
    'MCP server name',
    "The server's name, its message and the form it wants filled in",
    'Declines the request; no dialog appears.',
    'action: accept (with content), decline or cancel. No output shows the dialog as usual.',
    'Fill in a field you always answer the same way.',
  ),
  E(
    'ElicitationResult',
    'After you answer an MCP server, before the answer is sent back to it.',
    'MCP server name',
    'Your action and the content you entered',
    'Blocks the answer (it becomes a decline).',
    'accept with new content replaces the answer; decline; cancel.',
    'Check or tidy what is about to be sent to an outside server.',
  ),
  E(
    'PostToolUse',
    'After a tool call succeeds.',
    'Tool name',
    'tool_input, tool_response, tool_use_id',
    'Cannot undo the call; standard error is shown to Claude.',
    'decision: "block" with a reason, shown beside the result; additionalContext; updatedToolOutput.',
    'Format the edited file; run a linter.',
  ),
  E(
    'PostToolUseFailure',
    'After a tool call fails. Not for unknown tools, invalid input or denied permissions.',
    'Tool name',
    'tool_input, error, is_interrupt',
    NO_BLOCK + ' Standard error is shown to Claude.',
    'additionalContext only.',
    'Tell Claude what to try instead, such as an internal mirror when a download times out.',
  ),
  E(
    'PostToolBatch',
    'Once after a whole batch of parallel tool calls has finished, before the next model call.',
    'No matcher',
    'tool_calls: each with tool_name, tool_input and tool_response',
    'Stops the agentic loop before the next model call.',
    'decision: "block" or continue: false stops the loop; additionalContext is added once.',
    'Run the type checker once after four parallel edits, instead of four times.',
  ),
  E(
    'SubagentStart',
    'When a subagent is started.',
    'Agent type: Explore, Plan, general-purpose or your own',
    'agent_id, agent_type',
    NO_BLOCK,
    "additionalContext, added to the subagent's starting context.",
    'Tell every Explore subagent which folders matter.',
  ),
  E(
    'SubagentStop',
    'When a subagent finishes.',
    'Agent type',
    'agent_type, last_assistant_message, agent_transcript_path, stop_hook_active',
    'Keeps the subagent working; standard error is its next instruction.',
    'decision: "block" with a reason, delivered as the next instruction.',
    'Send a reviewer back if its findings have no file and line numbers.',
  ),
  E(
    'TaskCreated',
    'When a task is being created with TaskCreate.',
    'No matcher',
    'task_id, task_subject, task_description',
    'Deletes the task; standard error goes to Claude.',
    'decision: "block" with a reason does the same.',
    'Require a ticket number in every task subject.',
  ),
  E(
    'TaskCompleted',
    'When a task is being marked complete, or a teammate ends its turn with tasks in progress.',
    'No matcher',
    'task_id, task_subject, task_description',
    'The task stays open; standard error goes to the model.',
    'continue: false stops the teammate, when its turn caused the event.',
    'Keep a task open until its tests pass.',
  ),
  E(
    'Stop',
    'When Claude finishes responding. Not when you interrupt.',
    'No matcher',
    'stop_hook_active, last_assistant_message',
    'Claude keeps working; standard error is the reason.',
    'decision: "block" with a reason. After 8 continuations in a row Claude Code stops anyway (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).',
    'Make "done" mean the tests pass.',
  ),
  E(
    'StopFailure',
    'When the turn ends because of an API error. It runs instead of Stop.',
    'The error: rate_limit, overloaded, billing_error, server_error, max_output_tokens and others',
    'error, error_details, last_assistant_message',
    'Cannot block; output and exit code are ignored.',
    'Only terminalSequence (a terminal bell or title).',
    'Notify you that a long job stopped on a rate limit.',
  ),
  E(
    'TeammateIdle',
    'When a teammate in an agent team is about to go idle.',
    'No matcher',
    'teammate_name, agent_id',
    'The teammate keeps working; standard error goes to it.',
    'continue: false with a stopReason stops the teammate.',
    'Keep a teammate going while unclaimed tasks remain.',
  ),
  E(
    'PreCompact',
    'Before the conversation is compacted.',
    'manual (/compact) or auto',
    'trigger, custom_instructions',
    'Blocks compaction.',
    'decision: "block"; plain standard output becomes extra compaction instructions (up to 10,000 characters).',
    'Tell the summary to keep the changed files and the failing tests.',
  ),
  E(
    'PostCompact',
    'After compaction completes.',
    'manual or auto',
    'trigger, compact_summary',
    NO_BLOCK,
    'None.',
    'Save the summary for later reading.',
  ),
  E(
    'SessionEnd',
    'When the session ends.',
    'The reason: clear, resume, logout, prompt_input_exit or other',
    'reason',
    NO_BLOCK,
    'None. All SessionEnd hooks share a 1.5-second budget unless a hook sets its own timeout.',
    'Write a usage line; clean up temporary files.',
  ),
  E(
    'Notification',
    'When Claude Code sends a notification, such as waiting for permission or idle for a minute.',
    'notification_type: permission_prompt, idle_prompt, agent_needs_input and others',
    'message, title, notification_type',
    'Cannot block; ignored.',
    'None.',
    'Send the alert to your phone or chat.',
  ),
  E(
    'ConfigChange',
    'When a settings file or skill changes during a session.',
    'user_settings, project_settings, local_settings, policy_settings or skills',
    'source, file_path',
    'Blocks the change (not for policy settings).',
    'decision: "block".',
    'Refuse a change that removes the project hooks mid-session.',
  ),
  E(
    'PreModelSwitch',
    'Before a model switch that you or a client asked for. Runs before the switch, in order.',
    'Model name, such as .*opus.*',
    'from_model, to_model, prompt_cache_warm, estimated_cache_write_usd',
    'Cancels the switch; standard error is shown to you.',
    'permissionDecision: allow, deny or ask. A timeout blocks the switch.',
    'Warn before a switch that throws away a warm prompt cache.',
  ),
  E(
    'PostModelSwitch',
    'After the model changes, including changes Claude Code makes itself.',
    'Model name',
    'from_model, to_model, source',
    'Cannot block; the model has already changed.',
    'Context for the next request.',
    'Log which model did which part of the work.',
  ),
  E(
    'WorktreeCreate',
    'When a worktree is needed: --worktree, a subagent with isolation: worktree, or a background session. It replaces the default git behaviour.',
    'No matcher',
    'name',
    'Any non-zero exit fails the creation.',
    'The hook prints the absolute path of the new worktree as its last line.',
    'Use another version control system, or copy files git ignores.',
  ),
  E(
    'WorktreeRemove',
    'When a worktree that a WorktreeCreate hook made is removed.',
    'No matcher',
    'worktree_path',
    'A non-zero exit fails the removal if the folder is still there.',
    'None; the exit code decides.',
    'Remove what your WorktreeCreate hook made.',
  ),
  E(
    'CwdChanged',
    'When the working directory changes, for example after cd.',
    'No matcher',
    'old_cwd, new_cwd',
    NO_BLOCK,
    'watchPaths sets the files FileChanged watches.',
    "Load the new folder's environment variables.",
  ),
  E(
    'FileChanged',
    'When a watched file changes on disk, whoever changed it.',
    'File names: .envrc|.env',
    'file_path, event (change, add or unlink)',
    NO_BLOCK,
    'watchPaths.',
    'Reload environment variables when .envrc changes.',
  ),
  E(
    'DirectoryAdded',
    'When a working directory is added mid-session with /add-dir.',
    'slash_command or register_repo_root',
    'directory, source',
    NO_BLOCK,
    'None.',
    "Check the added folder's own rules.",
  ),
  E(
    'InstructionsLoaded',
    'When a CLAUDE.md or .claude/rules file is loaded into context.',
    'Why it loaded: session_start, nested_traversal, path_glob_match, include or compact',
    'file_path, memory_type, load_reason',
    'Ignored.',
    'None: it is for observing only.',
    'Find out which instructions were really loaded.',
  ),
  E(
    'MessageDisplay',
    "While Claude's reply is shown on screen.",
    'No matcher',
    'message_id, delta, final',
    'The original text is shown.',
    'displayContent replaces the text on screen only; the transcript and Claude keep the original.',
    'Mask secrets on screen during a demonstration.',
  ),
];

export const EVENT_BY_NAME = Object.fromEntries(HOOK_EVENTS.map((e) => [e.name, e])) as Record<string, HookEvent>;

/* The chart. Main column: [label, events, x-centre, y, width, colour group]. Side column: [label lines, note, events, y]. */
type Main = [string, string[], number, number, string];
const CX = 340;
const MAIN: Main[] = [
  ['Session Start', ['SessionStart'], 20, 180, 'start'],
  ['UserPromptSubmit', ['UserPromptSubmit'], 96, 180, 'grey'],
  ['PreToolUse', ['PreToolUse'], 196, 180, 'loop'],
  ['PermissionRequest', ['PermissionRequest'], 266, 180, 'loop'],
  ['[tool executes]', [], 336, 180, 'tool'],
  ['PostToolUse / PostToolUseFailure', ['PostToolUse', 'PostToolUseFailure'], 406, 270, 'loop'],
  ['PostToolBatch', ['PostToolBatch'], 476, 180, 'loop'],
  ['SubagentStart / SubagentStop', ['SubagentStart', 'SubagentStop'], 546, 250, 'loop'],
  ['TaskCreated', ['TaskCreated'], 616, 180, 'loop'],
  ['TaskCompleted', ['TaskCompleted'], 686, 180, 'loop'],
  ['Stop / StopFailure', ['Stop', 'StopFailure'], 786, 180, 'stop'],
  ['TeammateIdle', ['TeammateIdle'], 866, 180, 'grey'],
  ['PreCompact', ['PreCompact'], 936, 180, 'grey'],
  ['PostCompact', ['PostCompact'], 1006, 180, 'grey'],
  ['SessionEnd', ['SessionEnd'], 1076, 180, 'grey'],
];

type Side = [string[], string, string[], number, boolean?];
const SIDE: Side[] = [
  [['Setup'], 'opt-in', ['Setup'], 18],
  [['UserPrompt', 'Expansion'], 'slash commands', ['UserPromptExpansion'], 90],
  [['Permission', 'Denied'], 'auto-mode deny', ['PermissionDenied'], 262],
  [['Elicitation'], 'MCP input', ['Elicitation'], 316],
  [['ElicitationResult'], 'MCP input', ['ElicitationResult'], 366],
  [['Notification'], 'async', ['Notification'], 786],
  [['ConfigChange'], 'async', ['ConfigChange'], 838],
  [['PreModelSwitch'], 'in order', ['PreModelSwitch'], 890, true],
  [['PostModelSwitch'], 'async', ['PostModelSwitch'], 942],
  [['WorktreeCreate'], 'isolation', ['WorktreeCreate'], 994],
  [['WorktreeRemove'], 'teardown', ['WorktreeRemove'], 1046],
  [
    ['CwdChanged', 'FileChanged', 'DirectoryAdded'],
    'environment',
    ['CwdChanged', 'FileChanged', 'DirectoryAdded'],
    1098,
  ],
  [['InstructionsLoaded'], 'async', ['InstructionsLoaded'], 1172],
  [['MessageDisplay'], 'display', ['MessageDisplay'], 1224],
];

const H = 42; // main box height
const SX = 10,
  SW = 132; // side column
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mid = (y: number) => y + H / 2;

/** The lifecycle chart as an SVG string. Events in `on` are lit up; the rest dim when anything is lit. */
export function lifecycleSvg(on: string[] = [], opts: { title?: string } = {}): string {
  const lit = new Set(on);
  const cls = (events: string[]) => (events.some((e) => lit.has(e)) ? ' on' : lit.size ? ' dim' : '');
  const node = (events: string[]) =>
    events.length
      ? ` data-ev="${events.join(' ')}" tabindex="0" role="button" aria-label="${esc(events.join(' and '))}: show details"`
      : '';
  const arrow = (x1: number, y1: number, x2: number, y2: number, c = 'hl-flow') =>
    `<line class="${c}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#hl-a)"/>`;
  let s = `<svg class="hl-svg" viewBox="0 0 600 1280" xmlns="http://www.w3.org/2000/svg" role="group" aria-labelledby="hl-t">
<title id="hl-t">${esc(opts.title || 'The Claude Code hook lifecycle: 33 events')}</title>
<defs>
  <marker id="hl-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" class="hl-head"/></marker>
  <marker id="hl-al" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" class="hl-head-loop"/></marker>
  <marker id="hl-at" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" class="hl-head-turn"/></marker>
</defs>
<rect class="hl-bg" x="0" y="0" width="600" height="1280" rx="14"/>
<rect class="hl-turnbox" x="160" y="78" width="388" height="770" rx="10"/>
<text class="hl-zone hl-zone-turn" x="176" y="770">EACH</text><text class="hl-zone hl-zone-turn" x="176" y="786">TURN</text>
<rect class="hl-loopbox" x="182" y="150" width="326" height="592" rx="10"/>
<text class="hl-zone hl-zone-loop" x="198" y="172">AGENTIC</text><text class="hl-zone hl-zone-loop" x="198" y="188">LOOP</text>`;
  // straight arrows down the main column
  for (let i = 0; i < MAIN.length - 1; i++) s += arrow(CX, MAIN[i][2] + H, CX, MAIN[i + 1][2] - 2);
  // the agentic loop: TaskCompleted back to PreToolUse
  s += `<path class="hl-back-loop" d="M ${CX + 90} ${mid(686)} H 490 V ${mid(196)} H ${CX + 92}" marker-end="url(#hl-al)"/>`;
  // each turn: Stop back to UserPromptSubmit
  s += `<path class="hl-back-turn" d="M ${CX + 90} ${mid(786)} H 528 V ${mid(96)} H ${CX + 92}" marker-end="url(#hl-at)"/>`;
  // resumed sessions: SessionEnd back to SessionStart
  s += `<path class="hl-back-resume" d="M ${CX + 90} ${mid(1076)} H 572 V ${mid(20)} H ${CX + 92}" marker-end="url(#hl-a)"/>
<text class="hl-note" transform="translate(586 ${mid(560)}) rotate(90)" text-anchor="middle">resumed sessions</text>`;
  // side arrows: Setup → SessionStart, UserPromptSubmit → expansion, PermissionRequest → denied, elicitation → tool
  s += arrow(SX + SW, 18 + H / 2, CX - 92, mid(20), 'hl-side-flow');
  s += arrow(CX - 90, mid(96), SX + SW + 2, 90 + 24, 'hl-side-flow');
  s += arrow(CX - 90, mid(266), SX + SW + 2, 262 + 22, 'hl-side-flow');
  s += arrow(SX + SW, 366, CX - 92, mid(336), 'hl-side-flow');
  for (const [label, events, y, w, g] of MAIN) {
    s += `<g class="hl-node hl-${g}${cls(events)}"${node(events)}><rect x="${CX - w / 2}" y="${y}" width="${w}" height="${H}" rx="7"/><text x="${CX}" y="${mid(y) + 5}" text-anchor="middle">${esc(label)}</text></g>`;
  }
  for (const [lines, note, events, y, solid] of SIDE) {
    const h = 20 + lines.length * 14;
    const text = lines
      .map((l, i) => `<text x="${SX + SW / 2}" y="${y + 16 + i * 14}" text-anchor="middle">${esc(l)}</text>`)
      .join('');
    s += `<g class="hl-node hl-side${solid ? ' hl-solid' : ''}${cls(events)}"${node(events)}><rect x="${SX}" y="${y}" width="${SW}" height="${h}" rx="6"/>${text}<text class="hl-sub" x="${SX + SW / 2}" y="${y + h - 6}" text-anchor="middle">(${esc(note)})</text></g>`;
  }
  return s + '</svg>';
}

/** Details of one event as HTML, for the panel beside the chart. */
export function eventHtml(name: string): string {
  const e = EVENT_BY_NAME[name];
  if (!e) return '';
  const row = (k: string, v: string) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`;
  return `<h4><code>${esc(e.name)}</code></h4><p>${esc(e.when)}</p><table class="hl-facts"><tbody>${row('Matcher', e.matcher)}${row('Input', e.input)}${row('Exit code 2', e.exit2)}${row('JSON output', e.json)}${row('Typical use', e.use)}</tbody></table>`;
}
