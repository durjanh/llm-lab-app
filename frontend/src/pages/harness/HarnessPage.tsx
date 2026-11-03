import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './harness.css';

export default function HarnessPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-harness">
      <div className="kicker">Lab 16 · Harness engineering</div>
      <h1>The model thinks; the harness gets the job done</h1>
      <p className="lede">
        A model on its own answers one request and stops. Everything that turns it into an agent that works through a
        task is the <b>harness</b>: the code around the model. It runs the loop, provides tools, decides what goes into
        each request, keeps track of progress, checks the work, and decides when to stop.
      </p>
      <h2>1. What a harness is made of</h2>
      <div className="comp" id="components" />
      <h2>2. Is an autonomous agent a harness?</h2>
      <div className="answer">
        <p style={{ margin: '0' }}>
          <b>Yes. Autonomy is a property of the harness, not the model.</b> At each step the model only proposes the
          next action. The harness decides whether to keep going, what the model sees next, which actions are allowed,
          whether the work is really finished, and when to give up and ask a person. "Keep working until the job is
          done" is a loop with a definition of done, and both live in your code. Claude Code itself is a harness of this
          kind.
        </p>
      </div>
      <h2>3. Watch an autonomous agent work</h2>
      <p>
        The task: <i>"Make the three failing billing tests pass, then merge and deploy."</i> The agent runs by itself.
        Switch harness features off to see the failure each one prevents, then press Play. This is a scripted simulation
        that shows typical failure modes, not a live model.
      </p>
      <div className="card">
        <div className="toggles" id="toggles" />
        <div className="row" style={{ marginTop: '12px' }}>
          <span className="spacer" />{' '}
          <button className="btn" id="back">
            ‹ Back
          </button>
          <button className="btn primary" id="next">
            Next ›
          </button>
          <button className="btn" id="play">
            Play
          </button>
          <button className="btn" id="reset">
            Reset
          </button>
        </div>
        <div className="sim">
          <ol className="timeline" id="timeline" />
          <div>
            <div className="panel">
              <h4 id="todoTitle">Progress</h4>
              <div id="todos" />
            </div>
            <div className="panel">
              <h4>Context window</h4>
              <div className="meter">
                <i id="ctxBar" />
                <b id="ctxMark" style={{ left: '70%' }} />
              </div>
              <div className="small muted" id="ctxTxt" />
            </div>
            <div className="panel">
              <h4>Spend and turns</h4>
              <div className="small" id="spendTxt" />
            </div>
            <div className="outcome" id="outcome">
              Press Next or Play to start the run.
            </div>
          </div>
        </div>
      </div>
      <h2>4. The loop in code</h2>
      <p>
        The same design, runnable: <code>python/09_autonomous_agent.py</code> creates a small project with failing tests
        in a temporary folder and lets Claude fix it. The harness, not the model, decides when it is done.
      </p>
      <CodeBlock html={S.s1} />
      <h2>5. Build your own loop: ten tools, one agent or a team</h2>
      <p>
        A harness built the way Claude Code is built. You give a number and a task. Claude replies with{' '}
        <code>tool_use</code> blocks, JSON naming a tool and its input. The harness finds that tool by name, checks the
        permission rules, runs it, and sends every result back in one message, until Claude answers without asking for
        a tool. Seven tools are plain code. Three are <b>sub-agents</b>: each runs the same loop with an empty context,
        its own prompt and its own tools, and hands back only its answer. This is a scripted walk-through with real
        arithmetic; <code>python/11_harness_loop.py</code> runs it against Claude.
      </p>
      <div className="card">
        <div className="row hl-mode">
          <b className="small">Mode</b>
          <label>
            <input type="radio" name="hlMode" value="sim" defaultChecked /> Simulated
          </label>
          <label>
            <input type="radio" name="hlMode" value="live" id="hlLiveRadio" /> Live with Claude
          </label>
          <span className="small muted" id="hlLiveNote" />
        </div>
        <div className="row">
          <label>
            Number{' '}
            <input id="hlNum" type="number" min="2" max="100000" defaultValue="12" style={{ width: '90px' }} />
          </label>
          <label>
            Scenario{' '}
            <select id="hlScenario" defaultValue="chain">
              <option value="chain">Chain: one tool at a time</option>
              <option value="parallel">Parallel: independent tools together</option>
              <option value="team">Team: three worker agents in parallel</option>
              <option value="bash">Bash agent: commands behind permission rules</option>
              <option value="web">Web agent: search next to a code tool</option>
            </select>
          </label>
          <span className="spacer" />{' '}
          <button className="btn" id="hlBack">
            ‹ Back
          </button>
          <button className="btn" id="hlNext">
            Next ›
          </button>
          <span id="hlSimBtns">
            <button className="btn primary" id="hlPlay">
              Play
            </button>{' '}
            <button className="btn" id="hlReset">
              Reset
            </button>
          </span>
          <span id="hlLiveBtns" hidden>
            <select id="hlModel" aria-label="Model" />{' '}
            <button className="btn primary" id="hlRun">
              Run
            </button>{' '}
            <button className="btn" id="hlStop" disabled>
              Stop
            </button>
          </span>
        </div>
        <div className="hl-tools" id="hlTools" aria-label="The ten tools; the ones used in this step are highlighted" />
        <div className="sim">
          <ol className="timeline" id="hlTimeline" />
          <div>
            <div className="panel">
              <h4>JSON for this step</h4>
              <pre className="hl-json" id="hlJson" />
            </div>
            <div className="panel">
              <h4>Each agent's own conversation</h4>
              <div className="small" id="hlCtx" />
            </div>
            <div className="panel">
              <h4>Time</h4>
              <div className="small" id="hlTime" />
            </div>
            <div className="outcome" id="hlOutcome" />
          </div>
        </div>
      </div>
      <p style={{ marginTop: '16px' }}>
        The heart of the harness. The main agent and every sub-agent run through this same function:
      </p>
      <CodeBlock html={S.s2} />
      <h2>6. Skills: Claude makes a real file</h2>
      <p>
        A skill is a folder with a <code>SKILL.md</code> and any scripts it needs. Only its name and description sit in
        Claude's context; Claude reads the rest when a task needs it, and runs the scripts in Anthropic's code-execution
        container. Here Claude uses one of Anthropic's own skills to make a document about the numbers 2 to the number
        you choose, and the backend hands you the file. <code>python/12_agent_skills.py</code> does the same from the
        terminal, and can also upload a skill of your own.
      </p>
      <div className="card">
        <div className="row">
          <label>
            Skill{' '}
            <select id="skSkill" defaultValue="xlsx">
              <option value="xlsx">xlsx: a spreadsheet with a chart</option>
              <option value="pptx">pptx: a short slide deck</option>
              <option value="docx">docx: a one-page report</option>
              <option value="pdf">pdf: a one-page fact sheet</option>
            </select>
          </label>
          <label>
            Numbers up to{' '}
            <input id="skUpto" type="number" min="2" max="200" defaultValue="20" style={{ width: '80px' }} />
          </label>
          <select id="skModel" aria-label="Model" />
          <span className="spacer" />{' '}
          <button className="btn primary" id="skRun" disabled>
            Run
          </button>
          <button className="btn" id="skStop" disabled>
            Stop
          </button>
        </div>
        <div className="small muted" id="skStatus" style={{ margin: '8px 0' }} />
        <ol className="timeline" id="skSteps" />
        <div id="skFiles" style={{ marginTop: '10px' }} />
      </div>
      <h2>7. Build it yourself, or use a harness that exists</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Approach</th>
              <th>You write</th>
              <th>Who runs it</th>
              <th>Use when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Your own loop on the Claude API</td>
              <td>The whole loop, as above</td>
              <td>You host it</td>
              <td>You need full control of every step</td>
            </tr>
            <tr>
              <td>SDK tool runner</td>
              <td>Just the tool functions</td>
              <td>The SDK runs the loop; you host it</td>
              <td>A custom-tool agent without writing the loop</td>
            </tr>
            <tr>
              <td>Claude Agent SDK</td>
              <td>A prompt and options</td>
              <td>Claude Code's harness as a library, with built-in file, shell and search tools; you host it</td>
              <td>A batteries-included coding or file agent on your own infrastructure</td>
            </tr>
            <tr>
              <td>Claude Managed Agents</td>
              <td>An agent configuration and your tool results</td>
              <td>Anthropic runs the loop and a per-session sandbox</td>
              <td>Long-running or scheduled agents without running the infrastructure yourself</td>
            </tr>
            <tr>
              <td>Claude Code</td>
              <td>Settings, CLAUDE.md, skills and hooks</td>
              <td>An interactive harness on your machine</td>
              <td>
                Software work in your own repository; see the <a href="/claude-code">Claude Code setup lab</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Write down what "done" means, and check it in code.</b> A model saying "done" is a claim. Tests passing,
            a schema validating or a reviewer approving is evidence.
          </li>
          <li>
            <b>Keep progress outside the context.</b> A todo file or task list survives compaction and restarts; the
            model's memory of its plan does not.
          </li>
          <li>
            <b>Always set limits.</b> A maximum number of turns, a spending cap and a wall-clock timeout turn a runaway
            loop into a report that asks for help.
          </li>
          <li>
            <b>Retry the environment, not the model.</b> Timeouts and rate limits deserve automatic retries with backoff
            before the model ever sees them.
          </li>
          <li>
            <b>Gate irreversible actions.</b> Deploys, payments, deletions and messages to customers need an approval
            step or a policy check that the model cannot skip.
          </li>
          <li>
            <b>Manage the context deliberately.</b> Long runs need summaries, trimmed tool output and fresh sub-agents
            for side tasks; see the <a href="/context-engineering">Context engineering lab</a>.
          </li>
          <li>
            <b>Log every step.</b> You cannot debug or evaluate an agent whose decisions you cannot replay.
          </li>
        </ul>
      </div>
    </main>
  );
}
