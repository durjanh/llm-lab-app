import { useMemo, useState } from 'react';
import {
  CURRENT_DATA,
  RUNS,
  histogram,
  ks,
  pitDemo,
  promotionGate,
  promotionWarnings,
  psi,
  psiBand,
  retrainDecision,
  simulateRollout,
  spendSamples,
  type Strategy,
} from './mlops';

/* The MLOps page's interactive parts. Every number comes from mlops.ts, so the tests cover what is shown. */

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

/** Experiment runs to choose from, and the registry gate the chosen one must pass. */
export function RunsAndRegistry() {
  const [chosen, setChosen] = useState('run-d19');
  const run = RUNS.find((r) => r.id === chosen)!;
  const warnings = promotionWarnings(run);
  const [gap, setGap] = useState(4);
  const [latency, setLatency] = useState(90);
  const [signed, setSigned] = useState(false);
  const [champion, setChampion] = useState<{ version: number; run: string; auc: number }>({
    version: 12,
    run: 'run-b07',
    auc: 0.812,
  });
  const [history, setHistory] = useState<string[]>([]);
  const checks = promotionGate({
    auc: run.validation,
    minAuc: 0.8,
    sliceGap: gap / 100,
    maxSliceGap: 0.05,
    p95LatencyMs: latency,
    maxLatencyMs: 150,
    championAuc: champion.auc,
    signedOff: signed,
  });
  const usable = run.dataVersion === CURRENT_DATA;
  const passed = usable && checks.every((c) => c.pass) && champion.run !== run.id;

  function promote() {
    const version = champion.version + 1;
    setHistory((h) => [...h, `v${version} (${run.id}) became champion; v${champion.version} kept as the fallback`]);
    setChampion({ version, run: run.id, auc: run.validation });
  }
  function rollback() {
    setHistory((h) => [...h, `champion moved back to v12 (run-b07): one alias change, no redeploy`]);
    setChampion({ version: 12, run: 'run-b07', auc: 0.812 });
  }

  return (
    <>
      <h3>1. Choose a run to promote</h3>
      <p className="small muted">
        Five runs of a churn model, as a tracking server lists them. AUC on each split. Production data is{' '}
        <code>{CURRENT_DATA}</code>. Pick one.
      </p>
      <div className="table-wrap">
        <table className="t ml-runs">
          <thead>
            <tr>
              <th />
              <th>Run</th>
              <th>Algorithm and parameters</th>
              <th className="num">Train</th>
              <th className="num">Validation</th>
              <th className="num">Test</th>
              <th>Data</th>
              <th>Commit</th>
            </tr>
          </thead>
          <tbody>
            {RUNS.map((r) => (
              <tr key={r.id} className={r.id === chosen ? 'on' : undefined} onClick={() => setChosen(r.id)}>
                <td>
                  <input
                    type="radio"
                    name="ml-run"
                    aria-label={`Choose ${r.id}`}
                    checked={r.id === chosen}
                    onChange={() => setChosen(r.id)}
                  />
                </td>
                <td className="mono">{r.id}</td>
                <td>
                  {r.algorithm}
                  <div className="small muted mono">{r.params}</div>
                </td>
                <td className="num">{r.train.toFixed(3)}</td>
                <td className="num">{r.validation.toFixed(3)}</td>
                <td className="num">{r.test.toFixed(3)}</td>
                <td className="mono">{r.dataVersion}</td>
                <td className="mono">{r.commit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="ml-warnings" aria-live="polite">
        {warnings.map((w) => (
          <li key={w.text} className={`ml-${w.level}`}>
            {w.text}
          </li>
        ))}
      </ul>

      <h3>2. Register it and pass the gate</h3>
      <div className="grid2">
        <div className="card">
          <p className="small muted">Registered model</p>
          <p>
            <b className="mono">churn-model</b>
          </p>
          <div className="ml-aliases">
            <span className="ml-alias">
              @champion → v{champion.version} <span className="mono small">({champion.run})</span>
            </span>
            {champion.run !== run.id && (
              <span className="ml-alias challenger">
                @challenger → v{champion.version + 1} <span className="mono small">({run.id})</span>
              </span>
            )}
          </div>
          <p className="small muted">Lineage of the challenger</p>
          <ul className="small ml-lineage">
            <li>
              Run <span className="mono">{run.id}</span>, code commit <span className="mono">{run.commit}</span>
            </li>
            <li>
              Training data <span className="mono">{run.dataVersion}</span>, features from the feature store's{' '}
              <span className="mono">customer_activity</span> view
            </li>
            <li>
              {run.algorithm}, <span className="mono">{run.params}</span>
            </li>
          </ul>
          {history.length > 0 && (
            <ol className="small ml-history">
              {history.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
          )}
        </div>
        <div className="card">
          <label className="ml-field">
            <span>Largest recall gap between customer segments: {gap} points</span>
            <input type="range" min={0} max={15} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
          </label>
          <label className="ml-field">
            <span>p95 scoring latency: {latency} ms</span>
            <input
              type="range"
              min={20}
              max={300}
              step={10}
              value={latency}
              onChange={(e) => setLatency(Number(e.target.value))}
            />
          </label>
          <label className="ml-check">
            <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> The model owner has
            signed off
          </label>
          <ul className="ml-gate" aria-live="polite">
            {!usable && <li className="ml-bad">Not comparable: trained on {run.dataVersion}</li>}
            {checks.map((c) => (
              <li key={c.name} className={c.pass ? 'ml-ok' : 'ml-bad'}>
                <b>{c.pass ? 'Pass' : 'Fail'}</b> {c.name}: <span className="small">{c.detail}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="btn primary" disabled={!passed} onClick={promote}>
              Move @champion to the challenger
            </button>
            <button type="button" className="btn" disabled={champion.version === 12} onClick={rollback}>
              Roll back
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** A point-in-time join against a latest-value join, on invented churn data. */
export function PointInTime() {
  const r = useMemo(() => pitDemo(), []);
  const [mode, setMode] = useState<'pit' | 'latest'>('latest');
  const offline = mode === 'pit' ? r.pitOffline : r.leakyOffline;
  const live = mode === 'pit' ? r.pitOffline : r.leakyInProduction;
  return (
    <div className="card">
      <div className="chips" role="group" aria-label="How features are joined">
        <button type="button" className={`chip-btn${mode === 'latest' ? ' on' : ''}`} onClick={() => setMode('latest')}>
          Join the latest value
        </button>
        <button type="button" className={`chip-btn${mode === 'pit' ? ' on' : ''}`} onClick={() => setMode('pit')}>
          Join as of the label date
        </button>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Label date</th>
              <th>Left within 30 days</th>
              <th className={`num${mode === 'pit' ? ' ml-used' : ''}`}>Logins, 30 days before the label date</th>
              <th className={`num${mode === 'latest' ? ' ml-used' : ''}`}>Logins, latest snapshot</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row) => (
              <tr key={row.customer}>
                <td className="mono">{row.customer}</td>
                <td className="mono">{row.labelDate}</td>
                <td>{row.churned ? 'yes' : 'no'}</td>
                <td className={`num${mode === 'pit' ? ' ml-used' : ''}`}>{row.loginsAsOf}</td>
                <td className={`num${mode === 'latest' ? ' ml-used' : ''}`}>{row.loginsLatest}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="stats" aria-live="polite">
        <div className="stat">
          <div className="v">{pct(offline)}</div>
          <div className="k">accuracy in offline evaluation</div>
        </div>
        <div className="stat">
          <div className={`v${live < offline - 0.05 ? ' ml-bad' : ''}`}>{pct(live)}</div>
          <div className="k">accuracy in production, where only today's values exist</div>
        </div>
        <div className="stat">
          <div className="v">&lt; {mode === 'pit' ? r.pitThreshold : r.leakyThreshold}</div>
          <div className="k">logins below which the model it learned says "will leave"</div>
        </div>
      </div>
      <p className="small">
        {mode === 'latest'
          ? 'Customers who left have no logins after they left, so the latest snapshot gives the answer away. The model learns "zero logins means gone", scores almost perfectly offline, and fails in production, where everyone being scored is still a customer.'
          : 'Each label sees only what was known on its date. The offline score is lower but honest: it is what production will see.'}{' '}
        Out of 3,000 invented customers, 30% left; half train the model, half test it.
      </p>
    </div>
  );
}

const STRATEGIES: [Strategy, string, string][] = [
  [
    'shadow',
    'Shadow',
    'Every request is copied to the new model and its answers are logged, never shown. No risk to users; you pay for every call twice.',
  ],
  [
    'canary',
    'Canary',
    'A small share of users gets the new model, doubling every five healthy minutes. A bad version is caught while few people have seen it.',
  ],
  [
    'blue-green',
    'Blue-green',
    'The new version runs beside the old one and all traffic switches at once. Rolling back is a switch, but every user is exposed until then.',
  ],
  [
    'ab',
    'A/B test',
    'A fixed split held long enough to measure a business outcome, such as retention, not only errors. Guard metrics still stop it.',
  ],
];

/** Release a new model version four ways and watch the error rate. */
export function Rollout() {
  const [strategy, setStrategy] = useState<Strategy>('canary');
  const [share, setShare] = useState(5);
  const [newErr, setNewErr] = useState(6);
  const [limit, setLimit] = useState(3);
  const r = simulateRollout({
    strategy,
    startShare: share,
    oldErrorRate: 0.01,
    newErrorRate: newErr / 100,
    oldLatencyMs: 120,
    newLatencyMs: 95,
    rollbackAt: limit / 100,
  });
  const W = 640;
  const H = 200;
  const pad = { l: 40, r: 44, t: 12, b: 26 };
  const n = r.series.length;
  const x = (m: number) => pad.l + ((m - 0.5) / n) * (W - pad.l - pad.r);
  const bw = ((W - pad.l - pad.r) / n) * 0.8;
  const errMax = Math.max(0.1, ...r.series.map((s) => s.newErrorRate), limit / 100) * 1.1;
  const y = (f: number) => pad.t + (1 - f) * (H - pad.t - pad.b);
  const ye = (e: number) => y(e / errMax);
  const line = r.series
    .map((s, i) => `${i ? 'L' : 'M'}${x(s.minute).toFixed(1)} ${ye(s.newErrorRate).toFixed(1)}`)
    .join(' ');
  const desc = STRATEGIES.find((s) => s[0] === strategy)![2];

  return (
    <div className="card">
      <div className="chips" role="group" aria-label="Release strategy">
        {STRATEGIES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`chip-btn${strategy === id ? ' on' : ''}`}
            onClick={() => setStrategy(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="small">{desc}</p>
      <div className="ml-controls">
        <label className="ml-field">
          <span>
            {strategy === 'ab' ? 'Share on the new model' : 'Canary starts at'}: {share}%
          </span>
          <input
            type="range"
            min={1}
            max={50}
            value={share}
            disabled={strategy === 'shadow' || strategy === 'blue-green'}
            onChange={(e) => setShare(Number(e.target.value))}
          />
        </label>
        <label className="ml-field">
          <span>New model's real error rate: {newErr}% (old: 1%)</span>
          <input type="range" min={0} max={12} value={newErr} onChange={(e) => setNewErr(Number(e.target.value))} />
        </label>
        <label className="ml-field">
          <span>Roll back above: {limit}%</span>
          <input type="range" min={1} max={10} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </label>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="ml-chart"
        role="img"
        aria-label="Share of users on the new model and its error rate, minute by minute"
      >
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="ml-axis" />
        {r.series.map((s) => (
          <rect
            key={s.minute}
            x={x(s.minute) - bw / 2}
            y={y(s.newShare)}
            width={bw}
            height={Math.max(0, y(0) - y(s.newShare))}
            className="ml-bar"
          />
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={ye(limit / 100)} y2={ye(limit / 100)} className="ml-limit" />
        <path d={line} className="ml-line" />
        {r.rolledBackAt !== null && (
          <g>
            <line x1={x(r.rolledBackAt)} x2={x(r.rolledBackAt)} y1={pad.t} y2={y(0)} className="ml-rb" />
            <text x={x(r.rolledBackAt) + 4} y={pad.t + 12} className="ml-tick">
              rolled back
            </text>
          </g>
        )}
        <text x={pad.l - 6} y={y(1) + 4} textAnchor="end" className="ml-tick">
          100%
        </text>
        <text x={pad.l - 6} y={y(0) + 4} textAnchor="end" className="ml-tick">
          0
        </text>
        <text x={W - pad.r + 4} y={ye(limit / 100) + 4} className="ml-tick ml-tick-limit">
          {limit}%
        </text>
        <text x={pad.l} y={H - 6} className="ml-tick">
          minute 1
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="ml-tick">
          minute {n}
        </text>
      </svg>
      <p className="small muted ml-legend">
        <span className="ml-key bar" /> share of users on the new model <span className="ml-key line" /> new model's
        error rate so far <span className="ml-key limit" /> rollback threshold
      </p>
      <div className="stats" aria-live="polite">
        <div className="stat">
          <div className="v">{r.userErrors.toLocaleString('en-GB')}</div>
          <div className="k">errors users saw, of {r.userRequests.toLocaleString('en-GB')} requests</div>
        </div>
        <div className="stat">
          <div className="v">{r.newModelUserErrors.toLocaleString('en-GB')}</div>
          <div className="k">of them caused by the new model</div>
        </div>
        <div className="stat">
          <div className="v">{r.rolledBackAt === null ? 'no' : `minute ${r.rolledBackAt}`}</div>
          <div className="k">automatic rollback</div>
        </div>
        <div className="stat">
          <div className="v">+{pct(r.extraCalls, 0)}</div>
          <div className="k">extra model calls paid for</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round(r.meanLatencyMs)} ms</div>
          <div className="k">mean latency users saw (old 120, new 95)</div>
        </div>
      </div>
    </div>
  );
}

const BAND_TEXT = {
  stable: 'stable (under 0.1)',
  watch: 'worth watching (0.1 to 0.25)',
  drift: 'a real shift (0.25 and over)',
};

/** Shift a feature's distribution and watch PSI and KS; then decide whether to retrain. */
export function Drift() {
  const [shift, setShift] = useState(0);
  const [spread, setSpread] = useState(1);
  const [drop, setDrop] = useState<'none' | '0.01' | '0.05'>('none');
  const [fresh, setFresh] = useState(true);
  const { reference, current } = useMemo(() => spendSamples(shift, spread), [shift, spread]);
  const p = psi(reference, current);
  const k = ks(reference, current);
  const band = psiBand(p);
  const decision = retrainDecision({ psi: p, aucDrop: drop === 'none' ? null : Number(drop), freshLabels: fresh });
  const lo = 0;
  const hi = 110;
  const bins = 22;
  const hr = histogram(reference, lo, hi, bins);
  const hc = histogram(current, lo, hi, bins);
  const max = Math.max(...hr, ...hc);
  const W = 640;
  const H = 170;
  const bw = (W - 20) / bins;
  const y = (c: number) => H - 22 - (c / max) * (H - 34);

  return (
    <div className="grid2">
      <div className="card">
        <label className="ml-field">
          <span>
            Move this month's mean monthly spend by {shift >= 0 ? '+' : '−'}£{Math.abs(shift)}
          </span>
          <input type="range" min={-15} max={15} value={shift} onChange={(e) => setShift(Number(e.target.value))} />
        </label>
        <label className="ml-field">
          <span>Scale its spread by ×{spread.toFixed(1)}</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={spread}
            onChange={(e) => setSpread(Number(e.target.value))}
          />
        </label>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="ml-chart"
          role="img"
          aria-label="Monthly spend at training time and this month"
        >
          {hr.map((c, i) => (
            <rect key={`r${i}`} x={10 + i * bw} y={y(c)} width={bw - 2} height={H - 22 - y(c)} className="ml-ref" />
          ))}
          {hc.map((c, i) => (
            <rect key={`c${i}`} x={10 + i * bw} y={y(c)} width={bw - 2} height={H - 22 - y(c)} className="ml-cur" />
          ))}
          <text x={10} y={H - 6} className="ml-tick">
            £0
          </text>
          <text x={W - 10} y={H - 6} textAnchor="end" className="ml-tick">
            £110
          </text>
        </svg>
        <p className="small muted ml-legend">
          <span className="ml-key ref" /> at training time <span className="ml-key cur" /> this month
        </p>
        <div className="stats" aria-live="polite">
          <div className="stat">
            <div className={`v ml-band-${band}`}>{p.toFixed(3)}</div>
            <div className="k">PSI: {BAND_TEXT[band]}</div>
          </div>
          <div className="stat">
            <div className="v">{k.toFixed(3)}</div>
            <div className="k">KS statistic: the largest gap between the two cumulative curves</div>
          </div>
        </div>
      </div>
      <div className="card">
        <h3 className="ml-flush">Should it be retrained?</h3>
        <label className="ml-field">
          <span>Live AUC against the AUC at release</span>
          <select value={drop} onChange={(e) => setDrop(e.target.value as typeof drop)}>
            <option value="none">labels have not arrived yet</option>
            <option value="0.01">down 0.01</option>
            <option value="0.05">down 0.05</option>
          </select>
        </label>
        <label className="ml-check">
          <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Enough new labelled
          rows to train on
        </label>
        <p className={`ml-decision ml-act-${decision.action}`} aria-live="polite">
          <b>
            {
              { leave: 'Leave it', investigate: 'Investigate first', retrain: 'Retrain', wait: 'Wait for labels' }[
                decision.action
              ]
            }
          </b>
          <br />
          {decision.reason}
        </p>
        <p className="small muted">
          Churn labels arrive 30 days after a prediction, so input drift is the only early warning you get. It says the
          world moved, not that the model is wrong.
        </p>
      </div>
    </div>
  );
}
