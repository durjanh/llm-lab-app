import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './claude-code.css';

export default function ClaudeCodePage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-claude-code">
      <div className="kicker">Lab 17 · Claude Code setup</div>
      <h1>Make Claude Code work your way</h1>
      <p className="lede">
        Claude Code is a harness, and you can shape it. <b>CLAUDE.md</b> gives it standing knowledge, <b>skills</b> give
        it procedures it loads when needed, <b>hooks</b> run your own code at fixed moments, <b>subagents</b> do focused
        work in a separate context, and <b>plugins</b> package all of it for your team. Then the ways of working:{' '}
        <b>MCP servers</b> for outside tools, <b>plan mode</b> or straight to work, getting there in steps, running it{' '}
        <b>in CI</b>, and using it <b>from your editor</b>. Copyable versions of every example are in{' '}
        <code>examples/claude-code/</code>.
      </p>
      <p className="small muted">
        Formats and behaviour were checked against the Claude Code documentation at code.claude.com on 14 October 2026,
        and sections 8 to 12 on 13 November 2026. Claude Code changes often, so check the docs when something does not
        behave as described. This page and <a href="/claude-code-inside">Claude Code behind the scenes</a> together
        cover domain 3 of the <a href="/claude-architect">Claude Certified Architect exam</a>; the map at the end shows
        where.
      </p>
      <h2>1. Which one do I need?</h2>
      <p>Pick what you are trying to do.</p>
      <div className="needs chips" id="needs" />
      <div className="answer-card" id="answer" />
      <h2>2. What happens in a session</h2>
      <p>
        Step through one session in a project that uses all of these, and watch what enters Claude's context and what
        runs as plain code. Some things are always loaded, some load on demand, and hooks never enter the context unless
        they choose to report back.
      </p>
      <div className="row">
        <span className="spacer" />
        <button className="btn" id="sBack">
          ‹ Back
        </button>
        <button className="btn primary" id="sNext">
          Next ›
        </button>
        <button className="btn" id="sReset">
          Reset
        </button>
      </div>
      <div className="card" style={{ marginTop: '8px' }}>
        <h3 style={{ marginTop: '0' }} id="sTitle" />
        <p id="sText" />
        <div className="session">
          <div className="ctxcol">
            <h4>In Claude's context</h4>
            <div id="ctxCol" />
          </div>
          <div className="ctxcol">
            <h4>Runs outside the model</h4>
            <div id="extCol" />
          </div>
        </div>
        <div className="legend">
          <span style={{ '--c': 'var(--s1)' } as CSSProperties}>Always loaded</span>
          <span style={{ '--c': 'var(--s3)' } as CSSProperties}>Loaded on demand</span>
          <span style={{ '--c': 'var(--s2)' } as CSSProperties}>Hook: deterministic code</span>
          <span style={{ '--c': 'var(--s4)' } as CSSProperties}>Separate subagent context</span>
          <span style={{ '--c': 'var(--bad)' } as CSSProperties}>Blocked</span>
        </div>
      </div>
      <h2 id="claudemd">
        3. CLAUDE.md <span className="tag">standing knowledge</span>
      </h2>
      <p>
        CLAUDE.md files hold what Claude should know in every session: build commands, conventions, layout and "always
        do X" rules. They are delivered as context after the system prompt, not as enforced configuration, so Claude
        follows them as guidance.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Location</th>
              <th>Use for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Organisation</td>
              <td>
                <code>/Library/Application Support/ClaudeCode/CLAUDE.md</code> on macOS,{' '}
                <code>/etc/claude-code/CLAUDE.md</code> on Linux
              </td>
              <td>Managed policy every user gets</td>
            </tr>
            <tr>
              <td>You, everywhere</td>
              <td>
                <code>~/.claude/CLAUDE.md</code>
              </td>
              <td>Personal preferences across projects</td>
            </tr>
            <tr>
              <td>The project, shared</td>
              <td>
                <code>./CLAUDE.md</code> or <code>./.claude/CLAUDE.md</code>
              </td>
              <td>Team knowledge, committed to git</td>
            </tr>
            <tr>
              <td>The project, just you</td>
              <td>
                <code>./CLAUDE.local.md</code>
              </td>
              <td>
                Personal notes for this project; add it to <code>.gitignore</code>
              </td>
            </tr>
            <tr>
              <td>Part of the codebase</td>
              <td>
                <code>.claude/rules/*.md</code> with a <code>paths</code> field
              </td>
              <td>Rules that load only when matching files are touched</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="bp">
        <li>
          Files in the working directory and every directory above it load at launch, from the filesystem root down.
          They are concatenated, not overridden.
        </li>
        <li>CLAUDE.md files in subdirectories load when Claude reads or edits files there.</li>
        <li>
          Import other files with <code>@path/to/file</code>. The path is relative to the file that contains it, and
          imports can nest four deep. They load at launch, so they keep CLAUDE.md tidy but do not save context. In a
          monorepo, each package's CLAUDE.md can import just the standards that package needs.
        </li>
        <li>
          <code>CLAUDE.local.md</code> loads at launch next to the CLAUDE.md in the same folder. Rules in{' '}
          <code>.claude/rules/</code> without a <code>paths</code> field load at launch too;{' '}
          <code>~/.claude/rules/</code> holds your own rules for every project.
        </li>
        <li>
          <code>/init</code> drafts a CLAUDE.md from your codebase. <code>/memory</code> lists and opens the memory
          files. <code>/context</code> shows what loaded.
        </li>
      </ul>
      <CodeBlock html={S.s1} />
      <h3>Best practices</h3>
      <ul className="bp">
        <li>
          <b>Keep each file under about 200 lines.</b> Everything in it is paid for in every session.
        </li>
        <li>
          <b>Be concrete and checkable.</b> "Use 2-space indentation" beats "format code properly". "Run{' '}
          <code>npm test</code> before committing" beats "test your changes".
        </li>
        <li>
          <b>Add a line when Claude repeats a mistake,</b> or when you type the same correction twice.
        </li>
        <li>
          <b>Remove contradictions.</b> Faced with two conflicting rules, Claude may pick either.
        </li>
        <li>
          <b>Move procedures to skills</b> and part-of-the-codebase rules to <code>.claude/rules/</code>.
        </li>
        <li>
          <b>Use a hook for anything that must happen,</b> because CLAUDE.md is guidance, not enforcement.
        </li>
      </ul>
      <h3 id="rules">Rules for part of the codebase</h3>
      <p>
        A large CLAUDE.md can be split into topic files in <code>.claude/rules/</code>, such as <code>testing.md</code>,{' '}
        <code>api-conventions.md</code> and <code>deployment.md</code>. Give a rule a <code>paths</code> field with glob
        patterns and it loads only when Claude reads or edits a matching file, so it costs nothing the rest of the time.
      </p>
      <div className="grid2">
        <CodeBlock html={S.s9} />
        <ul className="bp" style={{ columns: '1' }}>
          <li>
            <b>Rule or folder CLAUDE.md?</b> A CLAUDE.md in <code>src/billing/</code> covers one folder. Test files are
            spread through the whole codebase, so a rule matching <code>**/*.test.tsx</code> is the only way to give
            them one set of conventions.
          </li>
          <li>
            <code>paths</code> takes a list or a comma-separated string, and braces expand:{' '}
            <code>"src/**/*.&#123;ts,tsx&#125;"</code>.
          </li>
          <li>
            Infrastructure conventions in <code>paths: ["terraform/**/*"]</code> stay out of every session that never
            touches Terraform.
          </li>
        </ul>
      </div>
      <div className="mistake">
        <b>Diagnose it:</b> a new teammate's sessions ignore the team's conventions. They were written in{' '}
        <code>~/.claude/CLAUDE.md</code> on someone else's machine, which is personal and never reaches git. Move them
        to <code>./CLAUDE.md</code> or <code>.claude/rules/</code> and commit them. <code>/memory</code> lists the
        memory files a session found, which is the quickest way to see what is and is not loaded.
      </div>
      <h2 id="skills">
        4. Skills <span className="tag">procedures on demand</span>
      </h2>
      <p>
        A skill is a folder with a <code>SKILL.md</code> file, plus any reference files and scripts it needs. Only the
        skill's description sits in context all the time. The full instructions load when Claude decides the skill is
        relevant, or when you type <code>/skill-name</code>. Extra files load only if the instructions point to them.
        Custom slash commands have been merged into skills: a file in <code>.claude/commands/</code> still works, but
        new work should be a skill.
      </p>
      <div className="grid2">
        <div>
          <div className="tree">
            {
              'my-skill/\n\u251c\u2500\u2500 SKILL.md        overview and instructions (required)\n\u251c\u2500\u2500 reference.md    detailed docs, loaded when needed\n\u251c\u2500\u2500 examples.md     usage examples, loaded when needed\n\u2514\u2500\u2500 scripts/\n    \u2514\u2500\u2500 helper.py   executed, not loaded'
            }
          </div>
          <p className="small">
            Locations: <code>~/.claude/skills/&lt;name&gt;/</code> for you, <code>.claude/skills/&lt;name&gt;/</code>{' '}
            for the project, or inside a plugin, where it is called as <code>/plugin-name:skill-name</code>.
          </p>
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Frontmatter field</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>description</code>
                </td>
                <td>
                  What it does and when to use it. Claude reads this to decide. The only field the docs recommend.
                </td>
              </tr>
              <tr>
                <td>
                  <code>name</code>
                </td>
                <td>
                  Optional; defaults to the folder name, which becomes <code>/name</code>.
                </td>
              </tr>
              <tr>
                <td>
                  <code>disable-model-invocation</code>
                </td>
                <td>
                  <code>true</code> means only you can start it. Use it for anything with side effects.
                </td>
              </tr>
              <tr>
                <td>
                  <code>user-invocable</code>
                </td>
                <td>
                  <code>false</code> means you do not run it as a command; use it for background knowledge Claude loads
                  when relevant.
                </td>
              </tr>
              <tr>
                <td>
                  <code>allowed-tools</code>
                </td>
                <td>
                  Tools it may use without asking while it runs. It approves; it does not take other tools away (
                  <code>disallowed-tools</code> does that).
                </td>
              </tr>
              <tr>
                <td>
                  <code>argument-hint</code>
                </td>
                <td>
                  Shown when you type the command, such as <code>[patch|minor|major]</code>, so people know what to
                  pass.
                </td>
              </tr>
              <tr>
                <td>
                  <code>context: fork</code>
                </td>
                <td>
                  Runs the skill as a separate subagent with no access to the conversation. Its verbose output stays out
                  of your session; only the result comes back.
                </td>
              </tr>
              <tr>
                <td>
                  <code>agent</code>
                </td>
                <td>
                  With <code>context: fork</code>: which subagent runs it, such as <code>Explore</code>,{' '}
                  <code>Plan</code> or one from <code>.claude/agents/</code>. The default is{' '}
                  <code>general-purpose</code>.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p>
        Arguments: <code>$ARGUMENTS</code> is everything you typed after the command. <code>$0</code> is the first
        argument and <code>$1</code> the second; the numbering starts at zero. A line such as{' '}
        <code>!`git diff HEAD`</code> runs the command first and inserts its output.
      </p>
      <div className="grid2">
        <div>
          <b className="small">Example from the docs: Claude can use it whenever relevant</b>
          <CodeBlock html={S.s2} className="wrap" />
        </div>
        <div>
          <b className="small">Side effects: only when you type /release minor</b>
          <CodeBlock html={S.s3} className="wrap" />
        </div>
      </div>
      <h3 id="commands">Commands and skills: the team's or yours</h3>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th />
              <th>The team's, committed to git</th>
              <th>Yours, on your machine only</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Skill</td>
              <td>
                <code>.claude/skills/&lt;name&gt;/SKILL.md</code>
              </td>
              <td>
                <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code>
              </td>
            </tr>
            <tr>
              <td>Command (older single-file form)</td>
              <td>
                <code>.claude/commands/&lt;name&gt;.md</code>
              </td>
              <td>
                <code>~/.claude/commands/&lt;name&gt;.md</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="bp">
        <li>
          A command file and a skill both create <code>/name</code>, with the same frontmatter. If both exist with one
          name, the skill wins.
        </li>
        <li>
          If a personal skill and a project skill share a name, <b>the personal one wins</b>. To try your own variant of
          a team skill without changing anything for teammates, give yours a different name, such as{' '}
          <code>/review-mine</code>.
        </li>
        <li>
          <b>Skill or CLAUDE.md?</b> CLAUDE.md is loaded in every session, so it holds universal standards. A skill
          loads when it is needed, so it holds task-specific workflows.
        </li>
      </ul>
      <div className="grid2">
        <div>
          <b className="small">A team command with an argument and pre-approved tools</b>
          <CodeBlock html={S.s10} className="wrap" />
        </div>
        <div>
          <b className="small">A forked skill: the exploring happens out of your context</b>
          <CodeBlock html={S.s11} className="wrap" />
        </div>
      </div>
      <p className="facts-note">
        Exam note: the Claude Certified Architect exam guide describes <code>allowed-tools</code> as restricting which
        tools a skill may use. The current Claude Code documentation describes it as pre-approving those tools, with{' '}
        <code>disallowed-tools</code> to remove others. Expect the exam's wording in questions; use the docs' behaviour
        in practice.
      </p>
      <h3>Best practices</h3>
      <ul className="bp">
        <li>
          <b>Write the description for the decision.</b> Put the main use case first and say when to use it, because
          that is all Claude sees until the skill loads.
        </li>
        <li>
          <b>Keep SKILL.md under 500 lines.</b> Move detailed reference material into separate files it links to.
        </li>
        <li>
          <b>Say what to do, not why.</b> Concise, direct steps work best.
        </li>
        <li>
          <b>Put deterministic work in scripts.</b> A script runs exactly the same way every time and costs no context
          to read.
        </li>
        <li>
          <b>Mark side effects</b> with <code>disable-model-invocation: true</code>, so deploys and releases only happen
          when you ask.
        </li>
      </ul>
      <h2 id="hooks">
        5. Hooks <span className="tag">your code, every time</span>
      </h2>
      <p>
        Hooks are shell commands, or HTTP calls and other handler types, that Claude Code runs at fixed points in a
        session. Unlike instructions, they do not depend on what Claude decides. That makes them the right tool for
        formatting, policy and notifications.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Event</th>
              <th>When it fires</th>
              <th>Typical use</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SessionStart</code>
              </td>
              <td>A session starts or resumes</td>
              <td>Load recent context, such as open tickets</td>
            </tr>
            <tr>
              <td>
                <code>UserPromptSubmit</code>
              </td>
              <td>Before Claude processes your prompt</td>
              <td>Add context, or block a prompt</td>
            </tr>
            <tr>
              <td>
                <code>PreToolUse</code>
              </td>
              <td>Before a tool call runs</td>
              <td>Block or approve it, or change its input</td>
            </tr>
            <tr>
              <td>
                <code>PostToolUse</code>
              </td>
              <td>After a tool call succeeds</td>
              <td>Format a file, run a linter</td>
            </tr>
            <tr>
              <td>
                <code>Notification</code>
              </td>
              <td>Claude Code sends a notification</td>
              <td>Desktop or chat alerts</td>
            </tr>
            <tr>
              <td>
                <code>Stop</code>
              </td>
              <td>Claude finishes responding</td>
              <td>Run checks, or block stopping to make it keep going</td>
            </tr>
            <tr>
              <td>
                <code>PreCompact</code>
              </td>
              <td>Before the conversation is compacted</td>
              <td>Save a transcript or notes</td>
            </tr>
            <tr>
              <td>
                <code>SessionEnd</code>
              </td>
              <td>The session ends</td>
              <td>Clean up, log usage</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="facts-note">
        These are the most used of 33 events. Others include PermissionRequest, PostToolUseFailure, SubagentStart,
        SubagentStop, TaskCompleted, FileChanged and PostCompact; the hooks reference lists them all.
      </p>
      <p>
        Hooks are configured in <code>~/.claude/settings.json</code> for you, <code>.claude/settings.json</code> for the
        project, <code>.claude/settings.local.json</code> for you in this project, in managed policy, in a plugin's{' '}
        <code>hooks/hooks.json</code>, or in a skill's or subagent's frontmatter. Each hook receives the event as JSON
        on standard input, including the tool name and its input.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Exit code</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>0</code>
              </td>
              <td>
                Success. Standard output can be JSON with a decision. For PreToolUse, exit 0 alone does not approve the
                call; normal permission rules still apply.
              </td>
            </tr>
            <tr>
              <td>
                <code>2</code>
              </td>
              <td>
                Block. Standard error goes back to Claude as the reason. Works for PreToolUse, UserPromptSubmit, Stop
                and some other events.
              </td>
            </tr>
            <tr>
              <td>
                anything else, including <code>1</code>
              </td>
              <td>A non-blocking error. The action goes ahead. Use exit 2 when you mean to enforce a policy.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="grid2">
        <div>
          <b className="small">.claude/settings.json: block protected files, format after edits</b>
          <CodeBlock html={S.s4} />
        </div>
        <div>
          <b className="small">.claude/hooks/protect-files.sh</b>
          <CodeBlock html={S.s5} />
        </div>
      </div>
      <h3>Best practices and safety</h3>
      <ul className="bp">
        <li>
          <b>Hooks run with your full user permissions.</b> Read every hook before adding it, especially from someone
          else's project.
        </li>
        <li>
          <b>Use exit code 2 to enforce.</b> Exit code 1 only reports an error and lets the action continue.
        </li>
        <li>
          <b>
            Quote shell variables, validate input, and reject <code>..</code> in paths.
          </b>
        </li>
        <li>
          <b>Use absolute paths</b> through <code>$CLAUDE_PROJECT_DIR</code>, so hooks work from any directory.
        </li>
        <li>
          <b>Keep hooks fast.</b> They run on every matching event.
        </li>
        <li>
          <b>For hard allow and deny rules, also use permission settings.</b> A hook's <code>if</code> filter is
          best-effort.
        </li>
      </ul>
      <div className="mistake">
        <b>Common mistake:</b> writing "never edit .env" in CLAUDE.md and assuming it is enforced. CLAUDE.md is
        guidance. A PreToolUse hook or a permission rule is enforcement.
      </div>
      <h2 id="subagents">
        6. Subagents <span className="tag">focused work, separate context</span>
      </h2>
      <p>
        A subagent is a specialised assistant with its own context window, instructions and tool list. Claude hands it a
        task and gets back a result, so long searches or reviews do not fill the main conversation. Define one as a
        Markdown file in <code>.claude/agents/</code> for the project or <code>~/.claude/agents/</code> for you.{' '}
        <code>name</code> and <code>description</code> are required.
      </p>
      <div className="grid2">
        <CodeBlock html={S.s6} />
        <ul className="bp" style={{ columns: '1' }}>
          <li>
            <b>Give it only the tools it needs.</b> A reviewer with Read, Glob and Grep cannot change anything.
          </li>
          <li>
            <b>Write the description for delegation.</b> Claude uses it to decide when to hand work over.
          </li>
          <li>
            <b>Use it to protect the main context.</b> Exploration that reads fifty files belongs in a subagent; only
            its summary comes back.
          </li>
          <li>
            Other optional fields include <code>model</code>, <code>maxTurns</code>, <code>permissionMode</code>,{' '}
            <code>skills</code> and <code>isolation: worktree</code>.
          </li>
        </ul>
      </div>
      <h2 id="plugins">
        7. Plugins <span className="tag">share it all</span>
      </h2>
      <p>
        A plugin bundles skills, subagents, hooks, MCP servers and more into one installable unit, so a team gets the
        same setup in every repository. The manifest <code>.claude-plugin/plugin.json</code> is optional, and{' '}
        <code>name</code> is its only required field. Everything else sits at the plugin's root, not inside{' '}
        <code>.claude-plugin/</code>.
      </p>
      <div className="grid2">
        <div>
          <div className="tree">
            {
              'my-first-plugin/\n\u251c\u2500\u2500 .claude-plugin/\n\u2502   \u2514\u2500\u2500 plugin.json\n\u251c\u2500\u2500 skills/\n\u2502   \u2514\u2500\u2500 hello/\n\u2502       \u2514\u2500\u2500 SKILL.md\n\u251c\u2500\u2500 agents/            optional subagents\n\u251c\u2500\u2500 hooks/hooks.json   optional hooks\n\u2514\u2500\u2500 .mcp.json          optional MCP servers'
            }
          </div>
          <CodeBlock html={S.s7} />
        </div>
        <div>
          <CodeBlock html={S.s8} />
          <p className="small">
            A plugin's skills are namespaced: the example above is called as <code>/my-first-plugin:hello</code>. Teams
            publish plugins through a marketplace, a repository with <code>.claude-plugin/marketplace.json</code> that
            lists them.
          </p>
        </div>
      </div>
      <h3>Best practices</h3>
      <ul className="bp">
        <li>
          <b>Start without a plugin.</b> Standalone skills and hooks are fine for one project. Package them once other
          repositories or teammates need them.
        </li>
        <li>
          <b>Keep plugins focused.</b> Every enabled plugin's skill and subagent descriptions sit in context on every
          turn.
        </li>
        <li>
          <b>Version them,</b> and validate before you publish.
        </li>
        <li>
          <b>Install only from sources you trust.</b> Plugins can carry hooks and MCP servers that run code on your
          machine.
        </li>
      </ul>
      <h2 id="mcp">
        8. MCP servers <span className="tag">outside tools and data</span>
      </h2>
      <p>
        An MCP server gives Claude Code tools and data from another system: an issue tracker, a database, a design tool.
        Every configured server's tools are found when Claude Code connects and are all available at once. Where the
        configuration lives decides who gets it.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Stored in</th>
              <th>Use for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>project</code>
              </td>
              <td>
                <code>.mcp.json</code> at the project root, committed
              </td>
              <td>Servers the whole team uses</td>
            </tr>
            <tr>
              <td>
                <code>user</code>
              </td>
              <td>
                <code>~/.claude.json</code>
              </td>
              <td>Your own and experimental servers, in every project</td>
            </tr>
            <tr>
              <td>
                <code>local</code> (the default)
              </td>
              <td>
                <code>~/.claude.json</code>, under this project's path
              </td>
              <td>A server for you, in this project only</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="grid2">
        <CodeBlock html={S.s12} />
        <CodeBlock html={S.s13} />
      </div>
      <ul className="bp">
        <li>
          <b>Keep secrets out of git</b> with <code>$&#123;VAR&#125;</code> in <code>.mcp.json</code>, or{' '}
          <code>$&#123;VAR:-default&#125;</code> for a fallback. Expansion works in the command, arguments, environment,
          URL and headers. Each person sets the variable on their own machine.
        </li>
        <li>
          Interactive sessions ask before using a project's servers for the first time;{' '}
          <code>claude mcp reset-project-choices</code> asks again. Print mode and the Agent SDK load them without
          asking.
        </li>
        <li>
          <b>Resources</b> expose a catalogue, such as open issues, a schema or a document tree. Attach one with{' '}
          <code>@server:protocol://path</code> so Claude sees what exists without exploratory tool calls. <b>Prompts</b>{' '}
          appear as <code>/server:prompt</code> commands.
        </li>
        <li>
          <b>Describe the tools well.</b> If an MCP tool's description is thin, Claude falls back on Grep and Bash. Say
          what it returns and when it beats the built-in tools.
        </li>
        <li>
          <b>Use an existing server for standard systems</b> such as GitHub or Jira, and build your own only for your
          team's own workflows. <a href="/mcp">The MCP servers lab</a> builds one.
        </li>
      </ul>

      <h2 id="plan">
        9. Plan mode or straight to work <span className="tag">match the mode to the task</span>
      </h2>
      <p>
        In plan mode Claude reads, searches and writes a plan, but changes nothing until you approve it. Enter it with{' '}
        <span className="kbd">Shift+Tab</span>, with <code>/plan</code>, or start with{' '}
        <code>claude --permission-mode plan</code>. Correcting a plan costs a sentence; undoing a wrong implementation
        across 40 files costs much more.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>The task</th>
              <th>Use</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A single-file fix with a clear stack trace; adding one date check</td>
              <td>Direct execution</td>
              <td>The scope is known; a plan adds a step and nothing else</td>
            </tr>
            <tr>
              <td>Migrating a library used in 45 files</td>
              <td>Plan mode, then execute</td>
              <td>Agree the approach once, then let it work through the files</td>
            </tr>
            <tr>
              <td>Restructuring a service into several</td>
              <td>Plan mode</td>
              <td>Architectural choices are cheap to change on paper</td>
            </tr>
            <tr>
              <td>A feature with two valid designs and different infrastructure needs</td>
              <td>Plan mode</td>
              <td>You choose between approaches before any code exists</td>
            </tr>
            <tr>
              <td>Finding your way round an unfamiliar codebase first</td>
              <td>The Explore subagent</td>
              <td>It reads many files in its own context and returns a summary, so your context stays small</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The common pattern combines them: investigate and plan in plan mode, approve, and let Claude implement the plan
        directly. The built-in Explore and Plan subagents are read-only, which is why plan mode can use them freely.{' '}
        <a href="/coding-agent">The coding agent lab</a> runs a real plan mode, where edits are refused until the plan
        is approved.
      </p>

      <h2 id="iterate">
        10. Getting there in steps <span className="tag">iterative refinement</span>
      </h2>
      <div className="grid2">
        <ul className="bp" style={{ columns: '1' }}>
          <li>
            <b>Show, do not describe.</b> When prose gives inconsistent results, two or three concrete input and output
            examples fix it: <i>"2026-11-03T09:00Z" becomes "3 Nov 2026, 09:00"; "" becomes null</i>.
          </li>
          <li>
            <b>Tests first.</b> Write tests for the expected behaviour, the edge cases and any speed limits, then let
            Claude iterate by sharing the failures. A Stop hook that runs the tests makes this automatic.
          </li>
          <li>
            <b>Fix an edge case with a test case.</b> "Null amounts break the migration" is vague; a test with that
            input and the expected output is not.
          </li>
        </ul>
        <ul className="bp" style={{ columns: '1' }}>
          <li>
            <b>Interview first, in unfamiliar ground.</b> Ask Claude to question you before it builds:{' '}
            <i>"Before writing the cache, ask me what you need to know about invalidation and failure modes."</i> It
            surfaces decisions you had not thought of.
          </li>
          <li>
            <b>Interacting problems: one message.</b> If fixing one issue changes another, describe them all together so
            the fixes fit.
          </li>
          <li>
            <b>Independent problems: one at a time.</b> Each fix can be checked on its own, and a failure does not hide
            the others.
          </li>
        </ul>
      </div>

      <h2 id="ci">
        11. Claude Code in CI <span className="tag">no terminal, nobody to ask</span>
      </h2>
      <p>
        <code>claude -p</code> runs one task without the interactive interface and exits, so a pipeline never hangs
        waiting for input. Add <code>--output-format json</code> with <code>--json-schema</code> and the validated
        result appears in <code>structured_output</code>, ready for a script to post as review comments. A complete
        workflow is in <code>examples/claude-code/ci/</code>;{' '}
        <a href="/claude-code-inside#ci">Claude Code behind the scenes</a> plays it step by step.
      </p>
      <div className="grid2">
        <CodeBlock html={S.s14} className="wrap" />
        <CodeBlock html={S.s15} />
      </div>
      <ul className="bp">
        <li>
          <b>Decide permissions up front.</b> Nobody can approve a prompt in CI: allow the tools the job needs with{' '}
          <code>--allowedTools</code>, and <code>--permission-mode dontAsk</code> refuses the rest.
        </li>
        <li>
          <b>CLAUDE.md briefs every run:</b> the review criteria, testing standards and available fixtures. Vague
          criteria such as "be conservative" do not cut false positives; naming what to report and what to skip does.
        </li>
        <li>
          <b>Review with a fresh instance.</b> The session that wrote the code is less likely to question it. A separate{' '}
          <code>claude -p</code> run starts without that reasoning.
        </li>
        <li>
          <b>On a new commit, pass the earlier findings</b> and ask only for new or still-open issues, so the same
          comment is not posted on every push.
        </li>
        <li>
          <b>For test generation, include the existing tests</b> so it does not suggest scenarios already covered.
        </li>
        <li>
          The ready-made route is the GitHub Action <code>anthropics/claude-code-action@v1</code>, installed by running{' '}
          <code>/install-github-app</code> in Claude Code. Its <code>prompt</code> input is the task and{' '}
          <code>claude_args</code> passes any of the flags above.
        </li>
      </ul>

      <h2 id="ide">
        12. In your editor <span className="tag">VS Code and JetBrains</span>
      </h2>
      <p>
        The same Claude Code runs in the editor, with the same CLAUDE.md, skills, hooks and MCP servers. The editor adds
        what a terminal cannot see.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th />
              <th>VS Code (and Cursor)</th>
              <th>JetBrains IDEs</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Install</td>
              <td>The Claude Code extension</td>
              <td>The plugin from the JetBrains Marketplace, plus the CLI</td>
            </tr>
            <tr>
              <td>What it adds</td>
              <td colSpan={2}>
                Proposed changes as diffs to accept or reject, your selection and open file as context, and the editor's
                errors and warnings through a diagnostics tool
              </td>
            </tr>
            <tr>
              <td>Insert a file reference</td>
              <td>
                <span className="kbd">Option+K</span> on a Mac, <span className="kbd">Alt+K</span> elsewhere
              </td>
              <td>
                <span className="kbd">Cmd+Option+K</span> on a Mac, <span className="kbd">Alt+Ctrl+K</span> elsewhere
              </td>
            </tr>
            <tr>
              <td>From a separate terminal</td>
              <td colSpan={2}>
                Run <code>/ide</code> to connect that session to the open editor
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="exam">Claude Certified Architect, domain 3: where each part is covered</h2>
      <p>
        Domain 3, Claude Code Configuration &amp; Workflows, is 20% of the exam. Every task statement in it, with the
        sections here and the chapters in <a href="/claude-code-inside">Claude Code behind the scenes</a>. Hooks and MCP
        are tested under domains 1 and 2 but configured here.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Task statement</th>
              <th>This page</th>
              <th>Behind the scenes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>3.1 CLAUDE.md hierarchy, scoping and modular organisation</td>
              <td>
                <a href="#claudemd">3. CLAUDE.md</a>, <a href="#rules">Rules</a>
              </td>
              <td>
                <a href="/claude-code-inside#request">Every request and CLAUDE.md</a>
              </td>
            </tr>
            <tr>
              <td>3.2 Custom slash commands and skills</td>
              <td>
                <a href="#skills">4. Skills</a>, <a href="#commands">The team's or yours</a>
              </td>
              <td>
                <a href="/claude-code-inside#skills">Skills</a>
              </td>
            </tr>
            <tr>
              <td>3.3 Path-specific rules</td>
              <td>
                <a href="#rules">Rules for part of the codebase</a>
              </td>
              <td>
                <a href="/claude-code-inside#request">Every request and CLAUDE.md</a>
              </td>
            </tr>
            <tr>
              <td>3.4 Plan mode or direct execution; the Explore subagent</td>
              <td>
                <a href="#plan">9. Plan mode</a>, <a href="#subagents">6. Subagents</a>
              </td>
              <td>
                <a href="/claude-code-inside#permissions">Permissions and modes</a>,{' '}
                <a href="/claude-code-inside#subagents">Subagents</a>
              </td>
            </tr>
            <tr>
              <td>3.5 Iterative refinement</td>
              <td>
                <a href="#iterate">10. Getting there in steps</a>
              </td>
              <td>
                <a href="/claude-code-inside#cheatsheet">Cheat sheet: a workflow that works</a>
              </td>
            </tr>
            <tr>
              <td>3.6 Claude Code in CI/CD</td>
              <td>
                <a href="#ci">11. Claude Code in CI</a>
              </td>
              <td>
                <a href="/claude-code-inside#ci">Headless and CI</a>
              </td>
            </tr>
            <tr>
              <td>Hooks (tested in 1.5)</td>
              <td>
                <a href="#hooks">5. Hooks</a>
              </td>
              <td>
                <a href="/claude-code-inside#hooks">Hooks</a>
              </td>
            </tr>
            <tr>
              <td>MCP servers (tested in 2.4)</td>
              <td>
                <a href="#mcp">8. MCP servers</a>
              </td>
              <td>
                <a href="/claude-code-inside#mcp">MCP</a>
              </td>
            </tr>
            <tr>
              <td>Sessions, resume and fork (tested in 1.7)</td>
              <td>—</td>
              <td>
                <a href="/claude-code-inside#rewind">/clear, rewind and resume</a>
              </td>
            </tr>
            <tr>
              <td>IDE integration</td>
              <td>
                <a href="#ide">12. In your editor</a>
              </td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="takeaways">
        <h3>The short version</h3>
        <ul>
          <li>
            <b>CLAUDE.md</b> for short, always-true facts. <b>Rules</b> for facts about one part of the codebase.
          </li>
          <li>
            <b>Skills</b> for procedures and reference material that should load only when relevant, including your own
            slash commands.
          </li>
          <li>
            <b>Hooks</b> for anything that must happen every time, or must never happen.
          </li>
          <li>
            <b>Subagents</b> for work that would flood the main context or needs a narrower set of tools.
          </li>
          <li>
            <b>MCP servers</b> to connect external tools and data, such as issue trackers or databases.
          </li>
          <li>
            <b>Plugins</b> to share a setup across a team and many repositories.
          </li>
          <li>
            <b>Plan mode</b> for changes with real choices in them; <b>direct execution</b> for a clear, small fix.
          </li>
          <li>
            <b>
              <code>claude -p</code>
            </b>{' '}
            with <code>--output-format json</code> and <code>--json-schema</code> to run it in CI.
          </li>
        </ul>
        <p className="small" style={{ marginTop: '8px' }}>
          Copy the examples from <code>examples/claude-code/</code>; its README says where each file goes. See the{' '}
          <a href="/harness">Harness engineering lab</a> for why these pieces matter.
        </p>
      </div>
    </main>
  );
}
