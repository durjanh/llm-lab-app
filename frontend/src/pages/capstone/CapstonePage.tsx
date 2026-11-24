import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { fitGP, suggest, type Acquisition, type GP } from '../tuning/gp';
import { CourseSection, Quiz, SectionNav, WhereUsed } from '../tuning/parts';
import { Key, Plot } from '../tuning/plot';
import {
  BLACK_BOXES,
  EMPTY,
  bestByRound,
  finished,
  history,
  optimum,
  parseSaved,
  regretByRound,
  roundsDone,
  submitRound,
  toMarkdown,
  type BlackBox,
  type Progress,
} from './functions';
import { QUIZ } from './quiz';
import './capstone.css';

/*
  The course capstone, week 25: optimise invented black boxes on a fixed budget, round by round, with optional
  Gaussian-process helpers from the tuning page. Progress stays in this browser's localStorage when it is
  available; the page works without it.
*/

const SECTIONS: [string, string][] = [
  ['brief', 'The brief'],
  ['play', 'The challenge'],
  ['portfolio', 'Make it a portfolio project'],
  ['python', 'In Python'],
  ['quiz', 'Check yourself'],
];

const STORE = 'llm-lab-capstone-v1';

function loadAll(): Record<string, Progress> {
  try {
    return parseSaved(window.localStorage.getItem(STORE));
  } catch {
    return {};
  }
}

/** True when this browser lets the page read what it saved; false in some private windows. */
function storageReadable(): boolean {
  try {
    return window.localStorage.getItem(STORE) !== null;
  } catch {
    return false;
  }
}

function saveAll(all: Record<string, Progress>) {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // Private windows and blocked storage: the page still works, it just forgets on reload.
  }
}

const blankRound = (box: BlackBox) => Array.from({ length: box.perRound }, () => box.inputs.map(() => ''));

/** A 2D view of the surrogate's mean, with the observations on top. Only for two-input black boxes. */
function Surrogate({ gp, points, latest }: { gp: GP; points: number[][]; latest: number }) {
  const N = 30;
  const S = 300;
  const cells = useMemo(() => {
    const v: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) v.push(gp.predict([(i + 0.5) / N, (j + 0.5) / N]).mean);
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    return v.map((x) => (x - lo) / (hi - lo || 1));
  }, [gp]);
  const c = S / N;
  return (
    <svg
      viewBox={`0 0 ${S} ${S}`}
      className="cp-heat"
      role="img"
      aria-label="The surrogate's predicted mean across both inputs, with every observation marked"
    >
      {cells.map((t, k) => (
        <rect
          key={k}
          x={Math.floor(k / N) * c}
          y={S - ((k % N) + 1) * c}
          width={c + 0.5}
          height={c + 0.5}
          className="cp-cell"
          fillOpacity={0.05 + 0.8 * t ** 1.5}
        />
      ))}
      {points.map((x, i) => (
        <circle
          key={i}
          cx={x[0] * S}
          cy={S - x[1] * S}
          r={i >= latest ? 5 : 3.5}
          className={i >= latest ? 'cp-new' : 'cp-old'}
        />
      ))}
    </svg>
  );
}

function Challenge() {
  const [all, setAll] = useState<Record<string, Progress>>(loadAll);
  const [boxId, setBoxId] = useState(BLACK_BOXES[0].id);
  const box = BLACK_BOXES.find((b) => b.id === boxId)!;
  const progress = all[box.id] ?? EMPTY;
  const [draft, setDraft] = useState<string[][]>(() => blankRound(box));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [helpers, setHelpers] = useState(false);
  const [kind, setKind] = useState<Acquisition>('ei');
  const [kappa, setKappa] = useState(2);
  const [ls, setLs] = useState(0.2);
  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState('');

  // Each change is applied to what is saved now and saved at once, so a second tab's rounds are not overwritten;
  // another tab's changes arrive as a storage event.
  useEffect(() => {
    const onStorage = () => setAll(loadAll());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const update = (change: (a: Record<string, Progress>) => Record<string, Progress>) => {
    const next = change(storageReadable() ? loadAll() : all);
    saveAll(next);
    setAll(next);
  };

  const choose = (id: string) => {
    const b = BLACK_BOXES.find((x) => x.id === id)!;
    setBoxId(id);
    setDraft(blankRound(b));
    setNote('');
    setError('');
    setConfirmReset(false);
  };

  const h = history(box, progress);
  const done = finished(box, progress);
  const round = roundsDone(box, progress);
  const best = h.reduce((a, b) => (b.y > a.y ? b : a));
  const gp = useMemo(
    () =>
      fitGP(
        h.map((o) => o.x),
        h.map((o) => o.y),
        { lengthScale: ls, signalVar: 1, noise: 0.01 },
      ),
    // h is rebuilt from progress on every render; progress and ls are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progress, ls, box.id],
  );

  const parsed = draft.map((row) => row.map((v) => (v.trim() === '' ? Number.NaN : Number(v))));
  const ready = parsed.every((row) => row.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));

  function fillSuggestions() {
    // Suggest one point, pretend it came back at the surrogate's mean, and suggest the next: a "believer" batch.
    const X = h.map((o) => o.x);
    const Y = h.map((o) => o.y);
    const rows: string[][] = [];
    for (let i = 0; i < box.perRound; i++) {
      const g = fitGP(X, Y, { lengthScale: ls, signalVar: 1, noise: 0.01 });
      const x = suggest(g, box.inputs.length, kind, box.seed * 97 + round * 13 + i, { kappa, exclude: X });
      rows.push(x.map((v) => v.toFixed(3)));
      X.push(x);
      Y.push(g.predict(x).mean);
    }
    setDraft(rows);
  }

  function submit() {
    try {
      update((a) => ({ ...a, [box.id]: submitRound(box, a[box.id] ?? EMPTY, parsed, note) }));
      setDraft(blankRound(box));
      setNote('');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    update((a) => {
      const { [box.id]: _gone, ...rest } = a;
      return rest;
    });
    setDraft(blankRound(box));
    setConfirmReset(false);
  }

  const markdown = toMarkdown(box, progress);
  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied('Copied');
    } catch {
      setCopied('Select the text and copy it');
    }
    setTimeout(() => setCopied(''), 1800);
  }
  const download = useMemo(() => {
    try {
      return URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    } catch {
      return '';
    }
  }, [markdown]);
  useEffect(() => () => (download ? URL.revokeObjectURL(download) : undefined), [download]);

  const bests = bestByRound(box, progress);
  const regret = done ? regretByRound(box, progress) : [];
  const opt = optimum(box);
  const preview = ready && helpers ? parsed.map((x) => gp.predict(x)) : [];

  return (
    <div className="card">
      <div className="chips" role="group" aria-label="Choose a black box">
        {BLACK_BOXES.map((b) => {
          const p = all[b.id];
          const r = p ? roundsDone(b, p) : 0;
          return (
            <button
              key={b.id}
              type="button"
              className={`chip-btn${b.id === box.id ? ' on' : ''}`}
              aria-pressed={b.id === box.id}
              onClick={() => choose(b.id)}
            >
              {b.name} · {b.inputs.length} inputs{r ? ` · ${r}/${b.rounds}` : ''}
            </button>
          );
        })}
      </div>
      <h3>{box.name}</h3>
      <p>{box.story}</p>
      <p className="small muted">
        Inputs, each scaled to 0–1: {box.inputs.join(', ')}. Output: {box.output}, higher is better. Budget:{' '}
        {box.initial} starting points, then {box.rounds} rounds of {box.perRound}. Noise: {box.noiseSd ? 'yes' : 'none'}
        .
      </p>

      <div className="stats">
        <div className="stat">
          <div className="v">
            {round}/{box.rounds}
          </div>
          <div className="k">rounds used</div>
        </div>
        <div className="stat">
          <div className="v">{best.y.toFixed(3)}</div>
          <div className="k">best {box.output} measured</div>
        </div>
        <div className="stat">
          <div className="v">{done ? opt.value.toFixed(3) : '?'}</div>
          <div className="k">{done ? 'the known optimum' : 'optimum, revealed after the last round'}</div>
        </div>
      </div>

      <div className="table-wrap cp-hist">
        <table className="t">
          <thead>
            <tr>
              <th>Round</th>
              {box.inputs.map((n) => (
                <th key={n} className="num">
                  {n}
                </th>
              ))}
              <th className="num">{box.output}</th>
            </tr>
          </thead>
          <tbody>
            {h.map((o, i) => (
              <tr key={i} className={o === best ? 'cp-best' : undefined}>
                <td>{o.round ? o.round : 'start'}</td>
                {o.x.map((v, j) => (
                  <td key={j} className="num">
                    {v.toFixed(3)}
                  </td>
                ))}
                <td className="num">
                  <b>{o.y.toFixed(3)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!done && (
        <div className="cp-round">
          <h3>Round {round + 1}</h3>
          <label className="row">
            <input type="checkbox" checked={helpers} onChange={(e) => setHelpers(e.target.checked)} /> Use the Gaussian
            process helpers
          </label>
          {helpers && (
            <div className="cp-helpers">
              <div className="cs-controls">
                <label className="cs-field">
                  <span>Length-scale: {ls.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0.05}
                    max={0.5}
                    step={0.01}
                    value={ls}
                    onChange={(e) => setLs(+e.target.value)}
                  />
                </label>
                <div className="chips" role="group" aria-label="Acquisition function">
                  {(
                    [
                      ['ei', 'Expected improvement'],
                      ['ucb', 'Upper confidence bound'],
                    ] as [Acquisition, string][]
                  ).map(([k, name]) => (
                    <button
                      key={k}
                      type="button"
                      className={`chip-btn${kind === k ? ' on' : ''}`}
                      aria-pressed={kind === k}
                      onClick={() => setKind(k)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                {kind === 'ucb' && (
                  <label className="cs-field">
                    <span>κ: {kappa.toFixed(1)}</span>
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={0.1}
                      value={kappa}
                      onChange={(e) => setKappa(+e.target.value)}
                    />
                  </label>
                )}
                <button type="button" className="btn" onClick={fillSuggestions}>
                  Fill this round with suggestions
                </button>
              </div>
              {box.inputs.length === 2 && (
                <div className="cp-surrogate">
                  <Surrogate gp={gp} points={[...h.map((o) => o.x), ...(ready ? parsed : [])]} latest={h.length} />
                  <p className="small muted">
                    The surrogate&apos;s mean: darker is higher. Across: {box.inputs[0]}; up: {box.inputs[1]}. Large
                    dots are this round&apos;s points.
                  </p>
                </div>
              )}
              <p className="small muted">
                Suggestions are a starting point. Change them if your own reasoning says otherwise, and say why in the
                note.
              </p>
            </div>
          )}
          {draft.map((row, i) => (
            <div key={i} className="cp-point">
              <span className="small muted">Point {i + 1}</span>
              {row.map((v, j) => (
                <label key={j} className="cs-field cp-in">
                  <span>{box.inputs[j]}</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.001}
                    inputMode="decimal"
                    value={v}
                    onChange={(e) =>
                      setDraft((d) => d.map((r, a) => (a === i ? r.map((c, b) => (b === j ? e.target.value : c)) : r)))
                    }
                  />
                </label>
              ))}
              {preview[i] && (
                <span className="small muted">
                  surrogate: {preview[i].mean.toFixed(3)} ± {(2 * preview[i].sd).toFixed(3)}
                </span>
              )}
            </div>
          ))}
          <label className="cs-field cp-note">
            <span>What are you trying this round, and why? (goes in your write-up)</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" className="btn primary" disabled={!ready} onClick={submit}>
              Run round {round + 1}
            </button>
            {!ready && <span className="small muted">Every value must be between 0 and 1.</span>}
            {error && <span className="small cs-bad">{error}</span>}
          </div>
        </div>
      )}

      <h3>Progress</h3>
      <Plot
        aria="Best measured value after the starting points and after each round"
        xDomain={[0, box.rounds]}
        yDomain={[0, 1.15]}
        height={200}
        xLabel="round (0 = starting points)"
        yLabel={`best ${box.output}`}
        series={[{ points: bests.map((v, i) => [i, v] as [number, number]), cls: 'pl-s1' }]}
        markers={bests.map((v, i) => ({ x: i, y: v, cls: 'pl-s1' }))}
        hlines={done ? [{ at: opt.value, cls: 'pl-good', label: 'optimum' }] : []}
      />
      {done && (
        <>
          <p>
            Finished. The optimum is <b>{opt.value.toFixed(3)}</b> at ({opt.x.map((v) => v.toFixed(2)).join(', ')}). The
            regret of your chosen point, measured on the clean function so a lucky reading does not count:{' '}
            <b>{regret[regret.length - 1].toFixed(3)}</b>.
          </p>
          <Plot
            aria="Regret after each round: how far the best point so far is below the optimum"
            xDomain={[0, box.rounds]}
            yDomain={[0, Math.max(0.05, ...regret)]}
            height={180}
            xLabel="round"
            yLabel="regret"
            series={[{ points: regret.map((v, i) => [i, v] as [number, number]), cls: 'pl-s2' }]}
          />
          <div className="pl-legend">
            <Key cls="pl-s2">regret: optimum minus the clean value of your best point</Key>
          </div>
        </>
      )}

      <h3>Your write-up</h3>
      <p className="small muted">
        Markdown for a portfolio README, built from your rounds and notes. It reveals the optimum only once every round
        is used.
      </p>
      <textarea className="cp-md" rows={8} readOnly value={markdown} aria-label="Your write-up as Markdown" />
      <div className="row">
        <button type="button" className="btn" onClick={copy}>
          {copied || 'Copy Markdown'}
        </button>
        {download && (
          <a className="btn" href={download} download={`capstone-${box.id}.md`}>
            Download .md
          </a>
        )}
        <span className="spacer" />
        <button type="button" className={`btn${confirmReset ? ' cp-danger' : ''}`} onClick={reset}>
          {confirmReset ? `Click again to erase ${box.name}` : 'Start this one again'}
        </button>
      </div>
    </div>
  );
}

const PYTHON = `# examples/ml-course/capstone/ has the same five black boxes, same seeds, same noise.
from blackbox import BLACK_BOXES, measure, starting_points

box = BLACK_BOXES["oven"]
X = starting_points(box)
y = [measure(box, x, i) for i, x in enumerate(X)]

# Your optimiser goes here: fit a surrogate (scikit-learn's GaussianProcessRegressor,
# or BoTorch), choose box.per_round points with an acquisition function, measure them,
# log why, repeat box.rounds times.
`;

export default function CapstonePage() {
  return (
    <main className="page-capstone">
      <p className="kicker">Course · week 25</p>
      <h1>Capstone: optimise a black box</h1>
      <p className="lede">
        Five invented systems, from a two-dial oven to a six-gain drone controller. You cannot see inside them; you can
        only try settings and read the result, and every try is limited. The job is to find settings as good as possible
        within the budget, and to explain each decision. It draws on most of the course: surrogates and acquisition
        functions, noise and evaluation, and writing up work so others can follow it.
      </p>
      <SectionNav sections={SECTIONS} />

      <CourseSection id="brief" title="The brief" weeks={[25]}>
        <ul>
          <li>
            Each black box takes 2 to 6 inputs, each scaled to the range 0 to 1, and returns one number. Higher is
            better. Some are noisy: the same settings can give slightly different readings.
          </li>
          <li>
            You start with a few measured points, the same for everyone. Then you have 10 rounds; in each you choose a
            fixed number of points, see their outputs, and write a short note on what you tried and why.
          </li>
          <li>
            The true optimum stays hidden until your last round. You are then scored on <b>regret</b>: how far the clean
            value of your best point is below the optimum.
          </li>
          <li>
            You may use the Gaussian-process helpers (built on the <Link to="/tuning">tuning page</Link>), your own code
            in Python, or reasoning alone. Whatever you use, the note for each round is the part that shows judgement.
          </li>
        </ul>
        <p className="small muted">
          Progress is saved in this browser only. Nothing is sent anywhere. Clearing site data, or a private window,
          starts you again.
        </p>
      </CourseSection>

      <CourseSection id="play" title="The challenge" weeks={[25]}>
        <Challenge />
      </CourseSection>

      <CourseSection id="portfolio" title="Make it a portfolio project" weeks={[25]}>
        <p>
          A good capstone repository lets a stranger see in five minutes what you did and why. Export the write-up above
          and build around it:
        </p>
        <ol>
          <li>
            <b>README.md</b>: the problem in two sentences, the result (best value, regret, rounds used), one plot of
            progress, and how to rerun it.
          </li>
          <li>
            <b>Method</b>: the surrogate (kernel, length-scale, noise), the acquisition function and how you changed the
            balance between exploring and exploiting as rounds passed. Say what you assumed about the function.
          </li>
          <li>
            <b>Decision log</b>: one entry per round, from your notes. Keep the rounds that went badly; they show you
            noticed and adjusted.
          </li>
          <li>
            <b>Plots</b>: best so far by round, regret by round, and for two inputs the surrogate with your points.
            Label the axes and say what each plot shows.
          </li>
          <li>
            <b>Code</b>: a notebook or script that reproduces every query from a fixed seed, with its dependencies
            pinned. Record each run as you would any experiment (see <Link to="/mlops#tracking">MLOps</Link>).
          </li>
          <li>
            <b>Reflection</b>: what you would do with twice the budget, and what would change if the function were far
            noisier or had ten inputs.
          </li>
        </ol>
      </CourseSection>

      <CourseSection id="python" title="The same black boxes in Python" weeks={[25]}>
        <p>
          <code>examples/ml-course/capstone/</code> defines the same five functions with the same seeds and noise, so a
          query in Python returns exactly what this page returns. Use it to write your own optimiser and to produce the
          plots for your write-up.
        </p>
        <CodeBlock html={highlight(PYTHON)} />
      </CourseSection>

      <CourseSection id="quiz" title="Check yourself" weeks={[25]}>
        <Quiz questions={QUIZ} />
      </CourseSection>

      <WhereUsed
        links={[
          [
            '/tuning',
            'Tuning and Bayesian optimisation',
            'the Gaussian process and acquisition functions behind the helpers',
          ],
          ['/model-evaluation', 'Model evaluation', 'why one lucky reading is not evidence'],
          ['/mlops', 'MLOps', 'tracking runs so the work can be repeated'],
          ['/ml', 'Machine learning algorithms', 'the models whose settings you would tune this way'],
        ]}
      />
    </main>
  );
}
