import { useEffect, useRef, useState } from 'react';
import { statusService } from '@/services/statusService';
import {
  planningPatternsService,
  type PatternEvent,
  type PatternId,
  type PatternResult,
  type PatternStep,
  type PatternsInfo,
} from '@/services/planningPatternsService';
import './planning-patterns.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const short = (v: unknown, n = 220) => {
  const s = JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const ABOUT: Record<PatternId, string> = {
  tool_loop: 'Native tool use, no written reasoning. The model calls tools until it calls final_answer.',
  react: 'The same loop, but a short Thought before every action: reason, act, observe, repeat.',
  plan_execute: 'A planner writes the steps; an executor does one at a time; a replanner revises after a failure.',
  reflexion: 'A ReAct attempt, a critic checks it against the task’s checks, then one more attempt if needed.',
};

/** One line of a pattern's trace. */
function Step({ s }: { s: PatternStep }) {
  switch (s.kind) {
    case 'call':
      return (
        <li className="pp-call">
          model call {s.calls}
          {s.role && s.role !== 'agent' ? ` · ${s.role}` : ''}
        </li>
      );
    case 'thought':
      return <li className="pp-thought">{s.text}</li>;
    case 'text':
      return <li className="pp-text">{s.text}</li>;
    case 'note':
      return <li className="pp-note">{s.text}</li>;
    case 'action':
      return (
        <li className="pp-action">
          <b>Action</b> <span className="mono">{s.tool}</span> <span className="mono small">{short(s.input, 160)}</span>
        </li>
      );
    case 'observation':
      return (
        <li className={`pp-obs${s.ok ? '' : ' bad'}`}>
          <b>{s.ok ? 'Observation' : 'Tool failed'}</b> <span className="mono small">{short(s.result)}</span>
        </li>
      );
    case 'plan':
      return (
        <li className="pp-plan">
          <b>{s.revision ? `Revised plan (${s.revision})` : 'Plan'}</b>
          <ol>
            {(s.steps ?? []).map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </li>
      );
    case 'step':
      return (
        <li className="pp-stephead">
          <b>Step:</b> {s.text}
        </li>
      );
    case 'step_done':
      return (
        <li className={`pp-stepdone${s.ok ? '' : ' bad'}`}>
          {s.ok ? '✓' : '✗'} {s.text}
        </li>
      );
    case 'attempt':
      return (
        <li className="pp-attempt">
          <b>First answer:</b> {s.text}
        </li>
      );
    case 'critique':
      return (
        <li className={`pp-critique${s.verdict === 'revise' ? ' bad' : ''}`}>
          <b>Critic: {s.verdict === 'revise' ? 'revise' : 'pass'}</b>
          {(s.problems ?? []).length > 0 && (
            <ul>
              {s.problems!.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </li>
      );
    default:
      return null;
  }
}

/** One pattern's column: live counters, the trace as it grows, then the marked answer. */
function Column({
  id,
  name,
  steps,
  result,
  running,
}: {
  id: PatternId;
  name: string;
  steps: PatternStep[];
  result?: PatternResult;
  running: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);
  const last = [...steps].reverse().find((s) => s.kind === 'call');
  return (
    <div className="pp-col">
      <div className="pp-col-head">
        <b>{name}</b>
        <span className="mono small muted">
          {last
            ? `${last.calls} calls · ${(last.tokens ?? 0).toLocaleString('en-GB')} tokens · ${usd(last.cost_usd ?? 0)}`
            : ''}
        </span>
      </div>
      <p className="small muted pp-about">{ABOUT[id]}</p>
      <ol className="pp-trace" ref={list}>
        {steps
          .filter((s) => s.kind !== 'start')
          .map((s, i) => (
            <Step key={i} s={s} />
          ))}
        {running && !result && (
          <li className="pp-call">
            <span className="pp-pulse" /> working…
          </li>
        )}
      </ol>
      {result && (
        <div className={`pp-result ${result.passed ? 'ok' : 'bad'}`}>
          <div>
            <b>{result.passed ? '✓ Right' : '✗ Wrong'}</b>
            {!result.passed && result.detail && <span className="small"> ({result.detail})</span>}
          </div>
          {result.answer && <div className="pp-answer">{result.answer}</div>}
          {result.stopped && <div className="small">{result.stopped}</div>}
        </div>
      )}
    </div>
  );
}

/** ReAct and planning patterns: one task, several agent patterns at once, each traced and marked by code. */
export default function PlanningPatternsPage() {
  const [info, setInfo] = useState<PatternsInfo | null>(null);
  const [error, setError] = useState('');
  const [task, setTask] = useState('stock');
  const [chosen, setChosen] = useState<PatternId[]>(['tool_loop', 'react', 'plan_execute', 'reflexion']);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState(0.25);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<{ task: string; patterns: PatternId[]; model: string } | null>(null);
  const [steps, setSteps] = useState<Partial<Record<PatternId, PatternStep[]>>>({});
  const [results, setResults] = useState<Partial<Record<PatternId, PatternResult>>>({});
  const [spent, setSpent] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    planningPatternsService
      .info()
      .then(setInfo)
      .catch((err) => setError(errorText(err)));
    statusService
      .status()
      .then((s) => {
        const offered = s.models || [];
        setModels(offered);
        setModel(offered.includes('claude-haiku-5-5') ? 'claude-haiku-5-5' : s.default_model || offered[0] || '');
      })
      .catch(() => undefined);
    return () => abort.current?.abort();
  }, []);

  const names = Object.fromEntries((info?.patterns ?? []).map((p) => [p.id, p.name])) as Record<PatternId, string>;
  const current = info?.tasks.find((t) => t.id === task);

  async function run() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const order = (info?.patterns ?? []).map((p) => p.id).filter((p) => chosen.includes(p));
    setRan({ task, patterns: order, model });
    setSteps({});
    setResults({});
    setError('');
    setRunning(true);
    try {
      await planningPatternsService.run(
        task,
        order,
        model,
        budget,
        (e: PatternEvent) => {
          if (e.type === 'step') setSteps((s) => ({ ...s, [e.pattern]: [...(s[e.pattern] ?? []), e] }));
          else if (e.type === 'result') setResults((r) => ({ ...r, [e.pattern]: e }));
          else if (e.type === 'done') setSpent((v) => v + e.spent_usd);
          else if (e.type === 'error') setError(e.message);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err));
    } finally {
      setRunning(false);
    }
  }

  const finished = ran ? ran.patterns.filter((p) => results[p]) : [];

  return (
    <main className="page-planning-patterns">
      <div className="kicker">Building · ReAct and planning patterns</div>
      <h1>Four ways to run the same agent</h1>
      <p className="lede">
        The same task, the same tools and the same model, run four ways at once: a plain tool loop, ReAct, plan and
        execute, and reflexion. Each column shows every thought, tool call and result as it happens. The tools work on
        an invented shop, so every task has one right answer, and code marks each pattern’s answer, not a model.
      </p>
      {error && <p className="pp-bad small">{error}</p>}

      <section className="card pp-section">
        <h2>1. Choose a task</h2>
        <div className="pp-tasks">
          {info?.tasks.map((t) => (
            <button
              key={t.id}
              className={`pp-task${t.id === task ? ' on' : ''}`}
              onClick={() => setTask(t.id)}
              disabled={running}
            >
              <span className={`pp-level ${t.level.toLowerCase()}`}>{t.level}</span>
              <b>{t.title}</b>
              <span className="small">{t.prompt}</span>
              {t.flaky && <span className="small muted">The warehouse system fails the first stock check.</span>}
            </button>
          ))}
        </div>
        {current && (
          <details className="small pp-checks">
            <summary>The task’s checks, and the right answer</summary>
            <p>Checks the critic is given (reflexion only):</p>
            <ul>
              {current.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p>
              Right answer, which code looks for in each final answer: <b>{current.expected}</b>
            </p>
          </details>
        )}

        <div className="pp-controls">
          <div className="pp-row">
            {info?.patterns.map((p) => (
              <label key={p.id} className="pp-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  disabled={running}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                />
                {p.name}
              </label>
            ))}
          </div>
          <div className="pp-row">
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running} title="Model">
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              disabled={running}
              title="The most this run may spend, all patterns together"
            >
              {[0.1, 0.25, 0.5, 1].map((b) => (
                <option key={b} value={b}>
                  up to ${b.toFixed(2)}
                </option>
              ))}
            </select>
            {running ? (
              <button className="btn" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button className="btn primary" disabled={!chosen.length || !model} onClick={() => void run()}>
                Run {chosen.length === 1 ? 'it' : `all ${chosen.length}`}
              </button>
            )}
            <span className="small muted">
              Each pattern stops at {info?.max_steps ?? 14} model calls ({info?.max_steps_plan ?? 24} for plan and
              execute, which needs more by design). Spent on this page: {usd(spent)}
            </span>
          </div>
        </div>
      </section>

      {ran && (
        <section className="card pp-section">
          <h2>2. What each pattern did</h2>
          <p className="small muted">
            {info?.tasks.find((t) => t.id === ran.task)?.prompt} · {ran.model}
          </p>
          <div className="pp-cols">
            {ran.patterns.map((p) => (
              <Column
                key={p}
                id={p}
                name={names[p] ?? p}
                steps={steps[p] ?? []}
                result={results[p]}
                running={running}
              />
            ))}
          </div>

          {finished.length > 0 && (
            <div className="table-wrap">
              <table className="t pp-compare">
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th>Answer</th>
                    <th>Model calls</th>
                    <th>Tool calls</th>
                    <th>Tokens in / out</th>
                    <th>Time</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {finished.map((p) => {
                    const r = results[p]!;
                    return (
                      <tr key={p}>
                        <td>{names[p]}</td>
                        <td className={r.passed ? 'pp-ok' : 'pp-bad'}>{r.passed ? '✓ right' : '✗ wrong'}</td>
                        <td className="mono">{r.model_calls}</td>
                        <td className="mono">{r.tool_calls}</td>
                        <td className="mono">
                          {r.input_tokens.toLocaleString('en-GB')} / {r.output_tokens.toLocaleString('en-GB')}
                        </td>
                        <td className="mono">{r.seconds} s</td>
                        <td className="mono">{usd(r.cost_usd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            One run is one sample. Models vary from run to run, so run a task a few times before you conclude that one
            pattern is better at it.
          </p>
        </section>
      )}

      <h2>The four patterns</h2>
      <div className="pp-explain">
        <div>
          <h3>Tool loop</h3>
          <p>
            The model is given tools, asks for one or more, gets the results, and repeats until it answers. This is what
            most production agents run today, including Claude Code. With extended or adaptive thinking switched on, the
            model reasons privately between calls.
          </p>
        </div>
        <div>
          <h3>ReAct</h3>
          <p>
            Reason and act, interleaved (Yao et al., 2022): a written Thought, then an Action, then the Observation, in
            a loop. The original parsed “Action: tool[input]” out of plain text, before models had native tool use.
            Today it is the tool loop with the reasoning written out, which makes the trace easier to follow and debug.
            Honestly: a modern tool loop already is ReAct in all but name.
          </p>
        </div>
        <div>
          <h3>Plan and execute</h3>
          <p>
            A planner writes the steps first; an executor does them one at a time; a replanner rewrites the rest of the
            plan when a step fails. More model calls, so it costs more, but the plan is a record a person can read and
            approve before anything happens, and independent steps can run in parallel.
          </p>
        </div>
        <div>
          <h3>Reflexion</h3>
          <p>
            Attempt, critique, retry (Shinn et al., 2023). A separate critic checks the attempt against the task’s
            checks and the tool results, and its critique goes into the second attempt. It catches mistakes that are
            visible in the trace, such as a policy applied wrongly. It cannot catch what neither attempt looked up.
          </p>
        </div>
      </div>

      <h2>When explicit planning helps, and when it hurts</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Helps</th>
              <th>Hurts</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Long tasks, where a loop can lose track of what is left</td>
              <td>Short tasks: a plan costs a model call and adds nothing</td>
            </tr>
            <tr>
              <td>Independent steps that can run in parallel</td>
              <td>Tasks where each step depends on what the last one found: the plan goes stale</td>
            </tr>
            <tr>
              <td>Audit and approval: a person can read the plan before it runs</td>
              <td>Rigid plans that carry on after the facts have changed, unless something replans</td>
            </tr>
            <tr>
              <td>A cheaper model can execute steps a stronger model planned</td>
              <td>More calls, more tokens and more time on every run</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small">
        A critic step (reflexion) is worth its cost where a wrong answer is expensive and the mistakes are checkable:
        money, policies, anything with rules. Elsewhere, a good tool loop with clear tool results is usually enough. See{' '}
        <a href="/agents">Agents and tools</a> for the loop itself and <a href="/agent-types">Agent types</a> for where
        each kind of agent fits.
      </p>

      {info && (
        <details className="pp-world">
          <summary>The invented shop the tools work on (today is {info.today})</summary>
          <div className="pp-explain">
            <div>
              <h3>Products</h3>
              <ul className="small">
                {info.products.map((p) => (
                  <li key={p.id}>
                    {p.id} {p.name}: £{p.price.toFixed(2)}, {p.stock} in stock
                  </li>
                ))}
              </ul>
              <h3>Orders</h3>
              <ul className="small">
                {info.orders.map((o) => (
                  <li key={o.id}>
                    {o.id} {o.customer}, placed {o.placed}, {o.status}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Policies</h3>
              <ul className="small">
                {Object.entries(info.policies).map(([k, v]) => (
                  <li key={k}>
                    <b>{k}.</b> {v}
                  </li>
                ))}
              </ul>
              <h3>Tools</h3>
              <ul className="small">
                {info.tools.map((t) => (
                  <li key={t.name}>
                    <span className="mono">{t.name}</span>: {t.description}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      )}
    </main>
  );
}
