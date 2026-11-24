import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ARMS,
  ARROWS,
  CLIFF,
  CLIFF_RUN,
  CLIFF_SEED,
  DEFAULT_GRID,
  DEFAULT_WORLD,
  banditRace,
  discounted,
  greedyPath,
  greedyPolicy,
  gridEnv,
  horizon,
  isCliff,
  learn,
  smooth,
  valueStep,
  zeros,
  type BanditAlgo,
  type BanditOptions,
  type Cell,
  type Grid,
  type WorldOptions,
} from './rl';

/* The reinforcement learning page's interactive parts. Every number comes from rl.ts, so the tests cover it. */

const ALGO_NAMES: Record<BanditAlgo, string> = {
  greedy: 'ε-greedy',
  ucb: 'UCB1',
  thompson: 'Thompson sampling',
};
const ALGO_CLASS: Record<BanditAlgo, string> = { greedy: 'rl-s1', ucb: 'rl-s2', thompson: 'rl-s3' };

/** A simple line chart. Series are drawn in the given classes, which take their colours from the theme. */
function LineChart({
  series,
  label,
  yLabel,
  height = 220,
}: {
  series: { name: string; values: number[]; cls: string }[];
  label: string;
  yLabel: string;
  height?: number;
}) {
  const W = 560;
  const H = height;
  const L = 50;
  const B = 28;
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all, lo + 1e-9);
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => L + (i / Math.max(1, n - 1)) * (W - L - 10);
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (H - B - 8);
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rl-chart" role="img" aria-label={label}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - 10} y1={y(t)} y2={y(t)} className="rl-grid" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" className="rl-axis">
            {Math.abs(t) >= 100 ? t.toFixed(0) : t.toFixed(1)}
          </text>
        </g>
      ))}
      {series.map((s) => {
        const step = Math.max(1, Math.floor(s.values.length / 400));
        const d = s.values
          .filter((_, i) => i % step === 0 || i === s.values.length - 1)
          .map((v, j) => `${j ? 'L' : 'M'}${x(Math.min(j * step, s.values.length - 1)).toFixed(1)} ${y(v).toFixed(1)}`)
          .join('');
        return <path key={s.name} d={d} className={`rl-line ${s.cls}`} />;
      })}
      <text x={L} y={H - 6} className="rl-axis">
        1
      </text>
      <text x={W - 10} y={H - 6} textAnchor="end" className="rl-axis">
        {n.toLocaleString('en-GB')}
      </text>
      <text x={(L + W) / 2} y={H - 6} textAnchor="middle" className="rl-axis">
        {yLabel}
      </text>
    </svg>
  );
}

function Legend({ items }: { items: { name: string; cls: string }[] }) {
  return (
    <div className="rl-legend">
      {items.map((i) => (
        <span key={i.name}>
          <i className={`rl-key ${i.cls}`} /> {i.name}
        </span>
      ))}
    </div>
  );
}

/** What a reward is worth when it arrives later, for a chosen discount factor. */
export function Discounting() {
  const [gamma, setGamma] = useState(0.9);
  const steps = Array.from({ length: 21 }, (_, t) => t);
  const h = horizon(gamma);
  return (
    <div className="card">
      <label className="rl-slider">
        <span>
          Discount factor γ: <b>{gamma.toFixed(2)}</b>
        </span>
        <input
          type="range"
          min={0}
          max={0.99}
          step={0.01}
          value={gamma}
          onChange={(e) => setGamma(Number(e.target.value))}
        />
      </label>
      <div className="rl-bars" aria-label="Value today of a reward of 1 received t steps from now">
        {steps.map((t) => (
          <div key={t} className="rl-bar-col">
            <span className="rl-bar" style={{ height: `${discounted(gamma, t) * 100}%` }} />
            <span className="rl-bar-t">{t % 5 === 0 ? t : ''}</span>
          </div>
        ))}
      </div>
      <p className="small">
        A reward of 1 arriving 10 steps from now is worth <b>{discounted(gamma, 10).toFixed(3)}</b> today. The agent
        effectively plans about <b>{Number.isFinite(h) ? h.toFixed(0) : '∞'}</b> steps ahead (1 ÷ (1 − γ)).
      </p>
    </div>
  );
}

/** Three bandit algorithms racing on the same visitors. */
export function Bandits() {
  const [draft, setDraft] = useState<BanditOptions>({ steps: 3000, epsilon: 0.1, c: 0.5 });
  const [opts, setOpts] = useState<BanditOptions>(draft);
  const race = useMemo(() => banditRace(opts, 20, 1), [opts]);
  const algos: BanditAlgo[] = ['greedy', 'ucb', 'thompson'];
  const changed = JSON.stringify(draft) !== JSON.stringify(opts);
  return (
    <div className="card">
      <div className="grid3">
        <label className="rl-slider">
          <span>
            Visitors: <b>{draft.steps.toLocaleString('en-GB')}</b>
          </span>
          <input
            type="range"
            min={500}
            max={6000}
            step={500}
            value={draft.steps}
            onChange={(e) => setDraft({ ...draft, steps: Number(e.target.value) })}
          />
        </label>
        <label className="rl-slider">
          <span>
            ε (ε-greedy): <b>{draft.epsilon.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={draft.epsilon}
            onChange={(e) => setDraft({ ...draft, epsilon: Number(e.target.value) })}
          />
        </label>
        <label className="rl-slider">
          <span>
            c (UCB1 bonus): <b>{draft.c.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={draft.c}
            onChange={(e) => setDraft({ ...draft, c: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="btn primary small" disabled={!changed} onClick={() => setOpts(draft)}>
          Run the race
        </button>
        <button type="button" className="btn small" onClick={() => setDraft({ ...draft, c: Math.SQRT2 })}>
          Textbook c = √2
        </button>
        <span className="small muted">Averaged over 20 runs; every algorithm meets the same visitors.</span>
      </div>
      <LineChart
        label="Cumulative regret"
        yLabel="visitors"
        series={algos.map((a) => ({ name: ALGO_NAMES[a], values: race[a].regret, cls: ALGO_CLASS[a] }))}
      />
      <Legend items={algos.map((a) => ({ name: ALGO_NAMES[a], cls: ALGO_CLASS[a] }))} />
      <p className="small muted">
        Regret: sign-ups lost compared with always showing the best page, which no one knows in advance. Lower is
        better; a line that keeps rising straight is still paying for exploration.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Page</th>
              <th className="num">True rate</th>
              {algos.map((a) => (
                <th key={a} className="num">
                  {ALGO_NAMES[a]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ARMS.map((arm, i) => (
              <tr key={arm.name}>
                <td>{arm.name}</td>
                <td className="num">{(arm.p * 100).toFixed(0)}%</td>
                {algos.map((a) => (
                  <td key={a} className="num">
                    {Math.round(race[a].pulls[i]).toLocaleString('en-GB')}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td>
                <b>Regret at the end</b>
              </td>
              <td />
              {algos.map((a) => (
                <td key={a} className="num">
                  <b>{race[a].regret[race[a].regret.length - 1].toFixed(1)}</b>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">The middle columns: how many visitors saw each page, on average.</p>
    </div>
  );
}

type Tool = Cell;
const TOOLS: [Tool, string][] = [
  ['wall', 'Wall'],
  ['pit', 'Pit'],
  ['goal', 'Goal'],
  ['start', 'Start'],
  ['empty', 'Clear'],
];

/** Colours a cell by its value: green above zero, red below, through the theme's own colours. */
function heat(v: number, max: number): CSSProperties {
  const a = Math.min(1, Math.abs(v) / Math.max(1e-9, max));
  return { background: `color-mix(in srgb, var(${v >= 0 ? '--good' : '--bad'}) ${Math.round(a * 45)}%, transparent)` };
}

function GridView({
  grid,
  values,
  arrows,
  onPaint,
  label,
}: {
  grid: Grid;
  values: number[][];
  arrows: (number | null)[][];
  onPaint?: (r: number, c: number) => void;
  label: string;
}) {
  const max = Math.max(1e-9, ...values.flat().map(Math.abs));
  return (
    <div className="rl-grid-wrap">
      <div
        className="rl-cells"
        style={{ gridTemplateColumns: `repeat(${grid[0].length}, minmax(0, 1fr))` }}
        role="grid"
        aria-label={label}
      >
        {grid.map((row, r) =>
          row.map((cell, c) => {
            const special = cell === 'goal' ? '+1' : cell === 'pit' ? '−1' : cell === 'wall' ? '' : null;
            return (
              <button
                key={`${r}-${c}`}
                type="button"
                className={`rl-cell rl-${cell}`}
                style={special === null ? heat(values[r][c], max) : undefined}
                onClick={onPaint ? () => onPaint(r, c) : undefined}
                disabled={!onPaint}
                aria-label={`Row ${r + 1}, column ${c + 1}: ${cell}${special === null ? `, value ${values[r][c].toFixed(2)}` : ''}`}
              >
                {special !== null ? (
                  <span className="rl-cell-main">{special}</span>
                ) : (
                  <>
                    <span className="rl-cell-main">{arrows[r][c] === null ? '' : ARROWS[arrows[r][c]!]}</span>
                    <span className="rl-cell-v">{values[r][c].toFixed(2)}</span>
                    {cell === 'start' && <span className="rl-cell-s">start</span>}
                  </>
                )}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}

/** The editable grid world: value iteration sweep by sweep, then Q-learning on the same world. */
export function GridLab() {
  const [grid, setGrid] = useState<Grid>(DEFAULT_GRID);
  const [tool, setTool] = useState<Tool>('wall');
  const [world, setWorld] = useState<WorldOptions>(DEFAULT_WORLD);
  const [V, setV] = useState<number[][]>(() => zeros(DEFAULT_GRID));
  const [sweeps, setSweeps] = useState(0);
  const [delta, setDelta] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const reset = (g: Grid = grid) => {
    setV(zeros(g));
    setSweeps(0);
    setDelta(null);
    setPlaying(false);
  };
  const sweep = () => {
    const s = valueStep(grid, V, world);
    setV(s.V);
    setDelta(s.delta);
    setSweeps((n) => n + 1);
    if (s.delta < 1e-4) setPlaying(false);
  };

  // While playing, each new set of values schedules the next sweep 300 ms later. Pausing, converging or leaving
  // the page clears the pending timer.
  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(sweep, 300);
    return () => window.clearTimeout(id);
  });

  const paint = (r: number, c: number) => {
    // The start can be moved but not painted over, so the grid always has one.
    if (grid[r][c] === 'start' && tool !== 'start') return;
    const next = grid.map((row) => row.map((cell) => (tool === 'start' && cell === 'start' ? 'empty' : cell))) as Grid;
    next[r][c] = tool;
    setGrid(next);
    reset(next);
  };
  const setOpt = (o: Partial<WorldOptions>) => {
    setWorld((w) => ({ ...w, ...o }));
    reset();
  };
  const policy = sweeps > 0 ? greedyPolicy(grid, V, world) : grid.map((row) => row.map(() => null));

  // Q-learning on the same world.
  const [alpha, setAlpha] = useState(0.2);
  const [epsilon, setEpsilon] = useState(0.2);
  const [episodes, setEpisodes] = useState(300);
  const q = useMemo(
    () => learn(gridEnv(grid, world), 'q', { alpha, gamma: world.gamma, epsilon, episodes, maxSteps: 100 }),
    [grid, world, alpha, epsilon, episodes],
  );
  const qValues = q.Q.map((row, r) => row.map((as, c) => (grid[r][c] === 'wall' ? 0 : Math.max(...as))));
  const qArrows = q.Q.map((row, r) =>
    row.map((as, c) => {
      const cell = grid[r][c];
      if (cell === 'wall' || cell === 'goal' || cell === 'pit' || as.every((v) => v === 0)) return null;
      return as.indexOf(Math.max(...as));
    }),
  );

  return (
    <>
      <div className="card">
        <div className="row">
          <span className="small">Paint:</span>
          <div className="chips" role="group" aria-label="Paint tool">
            {TOOLS.map(([t, name]) => (
              <button key={t} type="button" className={`chip-btn${tool === t ? ' on' : ''}`} onClick={() => setTool(t)}>
                {name}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setGrid(DEFAULT_GRID);
              reset(DEFAULT_GRID);
            }}
          >
            Reset the grid
          </button>
        </div>
        <div className="grid3">
          <label className="rl-slider">
            <span>
              Slip chance: <b>{(world.slip * 100).toFixed(0)}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={0.6}
              step={0.05}
              value={world.slip}
              onChange={(e) => setOpt({ slip: Number(e.target.value) })}
            />
          </label>
          <label className="rl-slider">
            <span>
              Discount γ: <b>{world.gamma.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={world.gamma}
              onChange={(e) => setOpt({ gamma: Number(e.target.value) })}
            />
          </label>
          <label className="rl-slider">
            <span>
              Reward per step: <b>{world.stepReward.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={-0.5}
              max={0}
              step={0.01}
              value={world.stepReward}
              onChange={(e) => setOpt({ stepReward: Number(e.target.value) })}
            />
          </label>
        </div>
      </div>

      <h3>Value iteration: planning with the rules known</h3>
      <div className="row">
        <button type="button" className="btn small" onClick={sweep} disabled={playing}>
          One sweep
        </button>
        <button type="button" className="btn primary small" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="btn small" onClick={() => reset()}>
          Start again
        </button>
        <span className="small muted" aria-live="polite">
          {sweeps} sweeps{delta !== null && `, largest change ${delta.toFixed(4)}`}
          {delta !== null && delta < 1e-4 && ': converged'}
        </span>
      </div>
      <GridView grid={grid} values={V} arrows={policy} onPaint={paint} label="Grid world values and policy" />
      <p className="small muted">
        Each sweep sets every cell to the best expected return of its four moves: the reward for where the move lands,
        plus γ times that cell’s current value, weighted by the chance of slipping. Values spread out from the goal and
        the pit one sweep at a time; the arrows are the greedy policy. Click cells to paint the world.
      </p>

      <h3>Q-learning: the same world, learned by trial</h3>
      <div className="grid3">
        <label className="rl-slider">
          <span>
            Learning rate α: <b>{alpha.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0.01}
            max={1}
            step={0.01}
            value={alpha}
            onChange={(e) => setAlpha(Number(e.target.value))}
          />
        </label>
        <label className="rl-slider">
          <span>
            Exploration ε: <b>{epsilon.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={epsilon}
            onChange={(e) => setEpsilon(Number(e.target.value))}
          />
        </label>
        <label className="rl-slider">
          <span>
            Episodes: <b>{episodes}</b>
          </span>
          <input
            type="range"
            min={10}
            max={1500}
            step={10}
            value={episodes}
            onChange={(e) => setEpisodes(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="grid2">
        <div>
          <GridView grid={grid} values={qValues} arrows={qArrows} label="Learned Q-values" />
          <p className="small muted">
            Each cell shows its best action’s learned value. Blank arrows are cells the agent never reached.
          </p>
        </div>
        <div>
          <LineChart
            label="Return per episode"
            yLabel="episodes"
            height={200}
            series={[{ name: 'Return', values: smooth(q.returns, 20), cls: 'rl-s1' }]}
          />
          <p className="small muted">
            Total reward per episode while still exploring, averaged over the last 20. Compare the arrows with value
            iteration’s: with enough episodes they agree, without the agent ever being told the slip chance.
          </p>
        </div>
      </div>
    </>
  );
}

/** Q-learning against SARSA on the cliff walk. */
export function Cliff() {
  const [epsilon, setEpsilon] = useState(CLIFF_RUN.epsilon);
  const runs = useMemo(() => {
    const o = { ...CLIFF_RUN, epsilon };
    const qr = learn(CLIFF, 'q', o, CLIFF_SEED);
    const sr = learn(CLIFF, 'sarsa', o, CLIFF_SEED);
    return { q: qr, sarsa: sr, qPath: greedyPath(CLIFF, qr.Q), sPath: greedyPath(CLIFF, sr.Q) };
  }, [epsilon]);
  const on = (path: [number, number][], r: number, c: number) => path.some(([pr, pc]) => pr === r && pc === c);
  const mean = (xs: number[]) => xs.slice(-100).reduce((s, x) => s + x, 0) / Math.min(100, xs.length);
  const reached = (p: [number, number][]) => {
    const [r, c] = p[p.length - 1];
    return r === 3 && c === 11;
  };
  return (
    <div className="card">
      <label className="rl-slider">
        <span>
          Exploration ε while learning: <b>{epsilon.toFixed(2)}</b>
        </span>
        <input
          type="range"
          min={0}
          max={0.3}
          step={0.01}
          value={epsilon}
          onChange={(e) => setEpsilon(Number(e.target.value))}
        />
      </label>
      <div className="rl-cliff" role="img" aria-label="Cliff walk with the greedy paths of Q-learning and SARSA">
        {Array.from({ length: 4 }, (_, r) =>
          Array.from({ length: 12 }, (_, c) => {
            const q = on(runs.qPath, r, c);
            const s = on(runs.sPath, r, c);
            const cls = isCliff(r, c) ? 'cliff' : r === 3 && c === 0 ? 'start' : r === 3 && c === 11 ? 'goal' : '';
            return (
              <span key={`${r}-${c}`} className={`rl-cc ${cls}`}>
                {cls === 'start' ? 'S' : cls === 'goal' ? 'G' : ''}
                {q && <i className="rl-dot rl-s2" />}
                {s && <i className="rl-dot rl-s3 second" />}
              </span>
            );
          }),
        )}
      </div>
      <Legend
        items={[
          { name: 'Q-learning’s path', cls: 'rl-s2' },
          { name: 'SARSA’s path', cls: 'rl-s3' },
        ]}
      />
      <div className="stats">
        <div className="stat">
          <div className="v">{reached(runs.qPath) ? `${runs.qPath.length - 1} steps` : 'no route'}</div>
          <div className="k">Q-learning’s greedy path</div>
        </div>
        <div className="stat">
          <div className="v">{reached(runs.sPath) ? `${runs.sPath.length - 1} steps` : 'no route'}</div>
          <div className="k">SARSA’s greedy path</div>
        </div>
        <div className="stat">
          <div className="v">{mean(runs.q.returns).toFixed(1)}</div>
          <div className="k">Q-learning: return per episode while exploring (last 100)</div>
        </div>
        <div className="stat">
          <div className="v">{mean(runs.sarsa.returns).toFixed(1)}</div>
          <div className="k">SARSA: return per episode while exploring (last 100)</div>
        </div>
      </div>
      <LineChart
        label="Return per episode on the cliff"
        yLabel="episodes"
        height={200}
        series={[
          { name: 'Q-learning', values: smooth(runs.q.returns, 25).map((v) => Math.max(v, -150)), cls: 'rl-s2' },
          { name: 'SARSA', values: smooth(runs.sarsa.returns, 25).map((v) => Math.max(v, -150)), cls: 'rl-s3' },
        ]}
      />
      <p className="small muted">
        Each step costs 1 and a fall costs 100. Returns are averaged over 25 episodes and cut off at −150 so the early
        disasters do not flatten the chart. “No route” means the greedy path loops before reaching the goal: some cells
        were visited too rarely to learn.
      </p>
    </div>
  );
}
