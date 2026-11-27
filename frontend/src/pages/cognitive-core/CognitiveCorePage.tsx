import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { startingModel } from '@/lib/models';
import { statusService } from '@/services/statusService';
import { cognitiveCoreService, type CoreEvent, type CoreInfo, type SetupId } from '@/services/cognitiveCoreService';
import { compare, studentClass, teacherClass, type Weights } from './distill';
import { cellKey, EMPTY, reduce, stepText, verdict, type RunState } from './results';
import './cognitive-core.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const COLOURS = ['#e07a5f', '#3d85c6', '#81b29a'];

/** A small model that reasons and looks things up, against a big one that remembers: run, then distilled. */
export default function CognitiveCorePage() {
  return (
    <main className="page-cognitive-core">
      <p className="kicker">Building</p>
      <h1>The Cognitive Core</h1>
      <p className="lede">
        Andrej Karpathy&apos;s idea: most of a large model&apos;s parameters hold knowledge, which could live outside
        it, in search, memory and tools. Strip that out, keep the part that reasons and uses tools, and a model of about
        a billion parameters might do the work, on a laptop or a phone. This page tests the claim instead of repeating
        it.
      </p>
      <p className="decides">
        <b>Helps you decide:</b> when a small local model with retrieval and tools is enough, and when the work still
        needs a big one.
      </p>
      <Experiment />
      <Distillation />
      <Lessons />
    </main>
  );
}

/** The six-way experiment: two models, each closed book, with retrieval done for it, and with its own tools. */
export function Experiment() {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [problem, setProblem] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [setups, setSetups] = useState<SetupId[]>([]);
  const [state, setState] = useState<RunState>(EMPTY);
  const [open, setOpen] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    cognitiveCoreService
      .info()
      .then((i) => {
        setInfo(i);
        setChosen(i.questions.map((q) => q.id));
        setSetups(i.setups.map((s) => s.id));
      })
      .catch((err) => setProblem(errorText(err)));
    statusService
      .status()
      .then((s) => {
        const offered = s.models || [];
        setModels(offered);
        setModel(startingModel(s.default_model, offered));
      })
      .catch(() => undefined);
    return () => abort.current?.abort();
  }, []);

  const names = Object.fromEntries((info?.setups ?? []).map((s) => [s.id, s.name])) as Record<string, string>;
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  async function run() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setProblem('');
    setState({ ...EMPTY, running: true });
    try {
      await cognitiveCoreService.run(
        chosen,
        setups,
        model,
        0.25,
        (e: CoreEvent) => setState((s) => reduce(s, e)),
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setProblem(errorText(err));
    } finally {
      setState((s) => ({ ...s, running: false }));
    }
  }

  if (!info) {
    return (
      <section className="card">
        <h2>Run the experiment</h2>
        <p className="muted">{problem || 'Loading the questions…'}</p>
      </section>
    );
  }
  const shownSetups = info.setups.filter((s) => setups.includes(s.id));
  const shownQuestions = info.questions.filter((q) => chosen.includes(q.id));
  return (
    <section className="card">
      <h2>Run the experiment</h2>
      <p>
        Two models answer the same questions three ways each. The small core is <code>{info.core_model}</code>; the big
        one is your choice. The reference library is mostly about an invented island, so no model can know those facts
        from training. Code marks every answer.
      </p>
      <div className="cc-controls">
        <label>
          Big model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={state.running}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Setups</legend>
          {info.setups.map((s) => (
            <label key={s.id} className="cc-check">
              <input
                type="checkbox"
                checked={setups.includes(s.id)}
                disabled={state.running}
                onChange={() => setSetups((list) => toggle(list, s.id))}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={run}
            disabled={state.running || !chosen.length || !setups.length}
          >
            {state.running ? 'Running…' : `Run ${chosen.length} question${chosen.length === 1 ? '' : 's'}`}
          </button>
          {state.running && (
            <button type="button" className="btn ghost" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          )}
        </div>
      </div>
      {problem && <p className="error">{problem}</p>}
      {state.error && <p className="error">{state.error}</p>}
      {state.summary.length > 0 && (
        <p className="cc-verdict" role="status">
          {verdict(state.summary, names)} Spent ${state.spent.toFixed(4)}.
        </p>
      )}
      <div className="cc-table-wrap">
        <table className="cc-table">
          <thead>
            <tr>
              <th>Question</th>
              {shownSetups.map((s) => (
                <th key={s.id}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {info.questions.map((q) => (
              <tr key={q.id} className={chosen.includes(q.id) ? '' : 'cc-off'}>
                <td>
                  <label className="cc-check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(q.id)}
                      disabled={state.running}
                      onChange={() => setChosen((list) => toggle(list, q.id))}
                    />
                    <span>
                      <span className="cc-kind">{q.kind}</span> {q.text}
                      <span className="cc-expected">Right answer: {q.expected}</span>
                    </span>
                  </label>
                </td>
                {shownSetups.map((s) => {
                  const key = cellKey(q.id, s.id);
                  const a = state.answers[key];
                  const steps = state.steps[key] ?? [];
                  return (
                    <td key={s.id} className={a ? (a.correct ? 'cc-right' : 'cc-wrong') : ''}>
                      {a ? (
                        <>
                          <b>{a.correct ? '✓ Right' : '✗ Wrong'}</b>
                          <span className="cc-answer">{a.answer || a.stopped || '(no answer)'}</span>
                          <span className="cc-meta">
                            {a.tool_calls} tool call{a.tool_calls === 1 ? '' : 's'} · {a.seconds}s
                          </span>
                        </>
                      ) : (
                        steps.length > 0 && <span className="cc-meta">working…</span>
                      )}
                      {steps.length > 0 && (
                        <button type="button" className="cc-trace" onClick={() => setOpen(open === key ? null : key)}>
                          {open === key ? 'Hide steps' : `Steps (${steps.length})`}
                        </button>
                      )}
                      {open === key && (
                        <ol className="cc-steps">
                          {steps.map((st, i) => (
                            <li key={i}>{stepText(st)}</li>
                          ))}
                        </ol>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shownQuestions.length === 0 && <p className="muted">Tick at least one question to run.</p>}
      <details>
        <summary>The reference library, the tools and the prompts</summary>
        <ul className="cc-library">
          {info.library.map((d) => (
            <li key={d.title}>
              <b>{d.title}.</b> {d.text}
            </li>
          ))}
        </ul>
        <p>
          <b>Closed book:</b> {info.prompts.closed}
        </p>
        <p>
          <b>Retrieval done for it:</b> {info.prompts.rag}
        </p>
        <p>
          <b>Its own tools:</b> {info.prompts.tools}
        </p>
      </details>
    </section>
  );
}

const GRID = 24;

/** The decision regions a classifier draws over the square, with the training points on top. */
export function Regions({
  title,
  classOf,
  points,
}: {
  title: string;
  classOf: (x: number, y: number) => number;
  points?: { x: number; y: number; label: number }[];
}) {
  const cells = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = -1 + (2 * (i + 0.5)) / GRID;
      const y = -1 + (2 * (j + 0.5)) / GRID;
      cells.push(
        <rect
          key={`${i}-${j}`}
          x={i}
          y={GRID - 1 - j}
          width={1}
          height={1}
          fill={COLOURS[classOf(x, y)]}
          opacity={0.55}
        />,
      );
    }
  }
  return (
    <figure className="cc-regions">
      <svg viewBox={`0 0 ${GRID} ${GRID}`} role="img" aria-label={title}>
        {cells}
        {(points ?? []).map((p, k) => (
          <circle
            key={k}
            cx={((p.x + 1) / 2) * GRID}
            cy={GRID - ((p.y + 1) / 2) * GRID}
            r={0.6}
            fill={COLOURS[p.label]}
            stroke="#111"
            strokeWidth={0.15}
          />
        ))}
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

/** Teacher and student, learning from bare labels and from soft targets, with sliders for the data and temperature. */
export function Distillation() {
  const [samples, setSamples] = useState(12);
  const [temperature, setTemperature] = useState(2);
  const result = useMemo(() => compare(samples, temperature), [samples, temperature]);
  const last = (h: number[]) => h[h.length - 1];
  const student = (w: Weights) => (x: number, y: number) => studentClass(w, x, y);
  return (
    <section className="card">
      <h2>Distillation: how a small model learns from a big one</h2>
      <p>
        A cognitive core would not be trained from scratch: it would learn from a big model (Hinton, Vinyals and Dean,
        2015). Here a teacher with curved boundaries sorts points into three classes. A student that can only draw
        straight lines learns from a few points, once from the bare labels and once from the teacher&apos;s full
        probabilities, softened by a temperature. Those soft targets say how close each point was to the other classes,
        so the same few points teach more.
      </p>
      <div className="cc-controls">
        <label>
          Labelled points: <b>{samples}</b>
          <input
            type="range"
            min={6}
            max={48}
            step={6}
            value={samples}
            onChange={(e) => setSamples(Number(e.target.value))}
          />
        </label>
        <label>
          Temperature: <b>{temperature}</b>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="cc-region-row">
        <Regions title="Teacher" classOf={teacherClass} />
        <Regions
          title={`Student, bare labels: ${pct(last(result.hard.history))}`}
          classOf={student(result.hard.weights)}
          points={result.train}
        />
        <Regions
          title={`Student, soft targets: ${pct(last(result.soft.history))}`}
          classOf={student(result.soft.weights)}
          points={result.train}
        />
      </div>
      <p className="muted">
        Accuracy is on 400 points the student never saw. The student is too small to copy the teacher&apos;s curves
        either way; soft targets help it place its straight lines where they cost least, and help most when labelled
        points are few. The same reason lets a small language model learn more from a big one&apos;s probabilities over
        every next token than from the text alone.
      </p>
    </section>
  );
}

/** What the experiment shows, where the idea breaks, and the pages for each ingredient. */
export function Lessons() {
  return (
    <section className="card">
      <h2>What it shows, and where it breaks</h2>
      <ul>
        <li>
          <b>Knowledge can live outside the model.</b> On the invented island every model is wrong closed book and right
          when the right entries are in front of it. That part of the claim holds, at any size.
        </li>
        <li>
          <b>Deciding to look things up is a skill, and small models lack it.</b> Given tools and told to search, the
          lab&apos;s 9B model searched every time; the 0.8B model never did, and answered from memory instead. A
          cognitive core has to be trained to lean on tools, which today&apos;s small chat models are not. Until then,
          the harness has to do the retrieval for it.
        </li>
        <li>
          <b>One search is not enough for a question that needs several facts.</b> Retrieval done once with the whole
          question misses facts a second search would find; an agent that searches again does better.
        </li>
        <li>
          <b>Reasoning still costs parameters.</b> Multi-step questions and longer contexts are where small models slip
          first, with or without the right facts.
        </li>
      </ul>
      <p>The other ingredients each have a page of their own:</p>
      <ul className="cc-links">
        <li>
          Retrieval: <Link to="/vector-db">vector database</Link>, <Link to="/graphrag">GraphRAG</Link>,{' '}
          <Link to="/search-pipeline">search pipeline</Link>
        </li>
        <li>
          Memory and context: <Link to="/agent-memory">agent memory</Link>,{' '}
          <Link to="/context-engineering">context engineering</Link>
        </li>
        <li>
          Tools: <Link to="/mcp">MCP servers</Link>, <Link to="/planning-patterns">ReAct and planning</Link>
        </li>
        <li>
          Many agents: <Link to="/workflows">agent workflows</Link>, <Link to="/research-team">research team</Link>
        </li>
        <li>
          Small and local: <Link to="/local-model">a local model</Link>, <Link to="/lora">fine-tuning with LoRA</Link>,{' '}
          <Link to="/routing">model routing</Link>
        </li>
      </ul>
    </section>
  );
}
