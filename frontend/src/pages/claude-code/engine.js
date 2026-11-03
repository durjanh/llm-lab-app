import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { $, $$, esc } = Site;

  // ---------- which mechanism ----------
  const NEEDS = [
    ['Tell Claude our build and test commands', 'CLAUDE.md', 'Facts Claude needs in every session belong in the project CLAUDE.md, committed so the whole team shares them.', './CLAUDE.md', '#claudemd'],
    ['Rules only for files under src/api/', 'A path-scoped rule', 'A Markdown file in .claude/rules/ with a paths field loads only when Claude touches matching files, so it costs nothing elsewhere.', '.claude/rules/api.md', '#claudemd'],
    ['Teach a multi-step procedure, like a release', 'A skill', 'Procedures load only when relevant or when you type the command. Set disable-model-invocation: true when it has side effects.', '.claude/skills/release/SKILL.md', '#skills'],
    ['A saved prompt with arguments, like /fix-issue 123', 'A skill', 'Skills are the slash commands now. Use $ARGUMENTS, or $0 for the first argument, in the instructions.', '.claude/skills/fix-issue/SKILL.md', '#skills'],
    ['Always run the formatter after Claude edits a file', 'A PostToolUse hook', 'Instructions can be forgotten; a hook runs every time. Match Edit|Write and run your formatter on the edited file.', '.claude/settings.json', '#hooks'],
    ['Never let Claude edit .env or lock files', 'A PreToolUse hook, plus permission rules', 'Exit code 2 blocks the tool call and tells Claude why. CLAUDE.md alone is not enforcement.', '.claude/hooks/protect-files.sh', '#hooks'],
    ['Review code in a separate context, read-only', 'A subagent', 'It gets its own context window and only the tools you list, and returns a summary to the main conversation.', '.claude/agents/code-reviewer.md', '#subagents'],
    ['Let Claude use our issue tracker or database', 'An MCP server', 'MCP connects external tools and data. Add it to the project, or ship it inside a plugin.', '.mcp.json', '#plugins'],
    ['Share all of this with the team and other repos', 'A plugin', 'A plugin bundles skills, subagents, hooks and MCP servers, installable from a marketplace.', 'my-plugin/.claude-plugin/plugin.json', '#plugins'],
    ['My personal preferences, not for the team', 'Your own CLAUDE.md', 'Use ~/.claude/CLAUDE.md for every project, or CLAUDE.local.md for just this one; keep the latter out of git.', '~/.claude/CLAUDE.md', '#claudemd']
  ];
  let need = 0;
  $('#needs').innerHTML = NEEDS.map((n, i) => `<button class="chip-btn${i === need ? ' on' : ''}" data-i="${i}">${esc(n[0])}</button>`).join('');
  function renderNeed() {
    const [, what, why, where, anchor] = NEEDS[need];
    $('#answer').innerHTML = `<h3>${esc(what)}</h3><p style="margin:0 0 6px">${esc(why)}</p><div class="where">${esc(where)}</div><p class="small" style="margin:6px 0 0"><a href="${anchor}">Details and an example below</a></p>`;
  }
  $('#needs').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; need = +b.dataset.i; $$('#needs .chip-btn').forEach(x => x.classList.toggle('on', x === b)); renderNeed(); });
  renderNeed();

  // ---------- session walkthrough ----------
  const STEPS = [
    { t: 'You start Claude Code in the project', d: 'Before you type anything, the memory files are loaded from the filesystem root down to the working directory and concatenated. Skill and subagent descriptions are listed, so Claude knows what exists without loading it all.',
      ctx: [['always', 'System prompt'], ['always', '~/.claude/CLAUDE.md', 'your personal preferences'], ['always', './CLAUDE.md', 'team commands and conventions'], ['always', 'Skill descriptions', 'summarize-changes, release: one line each'], ['always', 'Subagent descriptions', 'code-reviewer']], ext: [['hook', 'SessionStart hook', 'could add today\'s open tickets to the context']] },
    { t: 'You ask: "Fix the rounding bug in src/api/refunds.ts, then summarise my changes"', d: 'A UserPromptSubmit hook could check or enrich the prompt before Claude sees it. Here none is configured, so the prompt goes straight in.',
      ctx: [['demand', 'Your prompt']], ext: [] },
    { t: 'Claude opens src/api/refunds.ts', d: 'Touching a file under src/api/ triggers the path-scoped rule in .claude/rules/api.md, so the API rules load now and not before.',
      ctx: [['demand', '.claude/rules/api.md', 'loaded because a matching file was touched'], ['demand', 'refunds.ts', 'the file contents']], ext: [] },
    { t: 'Claude tries to edit .env as well', d: 'Before the edit runs, the PreToolUse hook receives the tool call as JSON. The path matches a protected pattern, so the script exits with code 2. The edit never happens, and the hook\'s message reaches Claude as the reason.',
      ctx: [['blocked', 'Blocked: .env is protected', 'the hook\'s stderr, returned to Claude']], ext: [['blocked', 'PreToolUse: protect-files.sh', 'exit 2: edit blocked']] },
    { t: 'Claude edits refunds.ts', d: 'The PreToolUse hook allows this file. After the edit succeeds, the PostToolUse hook runs Prettier on it. Claude did not decide to format; the hook simply runs every time.',
      ctx: [['demand', 'Edit result']], ext: [['hook', 'PreToolUse: protect-files.sh', 'exit 0: allowed'], ['hook', 'PostToolUse: prettier --write refunds.ts', 'runs on every edit']] },
    { t: 'Claude asks the reviewer subagent to check the change', d: 'The subagent starts with a fresh context, only Read, Glob and Grep, and its own instructions. It reads what it needs and returns a short review. Its file reading never enters the main context.',
      ctx: [['sub', 'Review summary from code-reviewer', 'only the result comes back']], ext: [['sub', 'code-reviewer subagent', 'separate context, read-only tools']] },
    { t: 'Claude uses the summarize-changes skill', d: 'Your request matches the skill\'s description, so the full SKILL.md loads now. Its !`git diff HEAD` line runs first and the diff is inserted. The release skill never loads: it has disable-model-invocation set and you did not type /release.',
      ctx: [['demand', 'summarize-changes/SKILL.md', 'full instructions, loaded on demand'], ['demand', 'Output of git diff HEAD', 'inserted by the skill']], ext: [['hook', 'git diff HEAD', 'run by the skill before Claude reads it']] },
    { t: 'Claude finishes its answer', d: 'A Stop hook could run the tests and exit with code 2 to make Claude keep working until they pass, the same verification gate as in the Harness lab.',
      ctx: [['demand', 'Claude\'s answer: fix, review notes, summary']], ext: [['hook', 'Stop hook', 'optional: block stopping until checks pass']] }
  ];
  let si = 0;
  function renderSession() {
    const s = STEPS[si];
    $('#sTitle').textContent = `${si + 1}. ${s.t}`; $('#sText').textContent = s.d;
    const ctx = STEPS.slice(0, si + 1).flatMap(x => x.ctx), ext = STEPS.slice(0, si + 1).flatMap(x => x.ext);
    const chunk = ([k, title, sub], fresh) => `<div class="chunk ${k}" style="${fresh ? '' : 'animation:none'}"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    const prevCtx = STEPS.slice(0, si).flatMap(x => x.ctx).length, prevExt = STEPS.slice(0, si).flatMap(x => x.ext).length;
    $('#ctxCol').innerHTML = ctx.map((c, i) => chunk(c, i >= prevCtx)).join('');
    $('#extCol').innerHTML = ext.length ? ext.map((c, i) => chunk(c, i >= prevExt)).join('') : '<span class="small muted">Nothing yet.</span>';
    $('#sBack').disabled = si === 0; $('#sNext').disabled = si === STEPS.length - 1;
  }
  $('#sNext').addEventListener('click', () => { si = Math.min(STEPS.length - 1, si + 1); renderSession(); });
  $('#sBack').addEventListener('click', () => { si = Math.max(0, si - 1); renderSession(); });
  $('#sReset').addEventListener('click', () => { si = 0; renderSession(); });
  renderSession();
}
