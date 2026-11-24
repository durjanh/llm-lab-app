import { useMemo, useState } from 'react';
import { CodeBlock } from '@/components/CodeBlock';
import { DATASHEET, MODEL_CARD, answered, exampleAnswers, renderMarkdown, type Answers, type DocSection } from './docs';
import {
  FEATURES,
  FEATURE_INFO,
  MODEL,
  POPULATION,
  SAMPLE,
  bestOfAllThree,
  calibration,
  counterfactuals,
  gaps,
  groupStats,
  iceCurves,
  matchThreshold,
  partialDependence,
  permutationImportance,
  predict,
  proxyReport,
  shapley,
  type Feature,
  type Group,
  type Point,
} from './model';

/* The interpretability page's interactive parts. Every number comes from model.ts, so the tests cover it. */

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const fmt = (f: Feature, v: number) =>
  f === 'debt' ? v.toFixed(2) : f === 'income' ? `£${v.toFixed(0)}k` : f === 'missed' ? v.toFixed(0) : v.toFixed(1);
const signed = (x: number, d = 3) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The model's four weights, read as what one unit more does to the odds of repaying. */
export function Coefficients() {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Feature</th>
            <th className="num">Weight (log-odds)</th>
            <th className="num">Odds multiplied by</th>
            <th>Per</th>
          </tr>
        </thead>
        <tbody>
          {FEATURES.map((f) => {
            const per = f === 'debt' ? 0.1 : f === 'income' ? 10 : 1;
            return (
              <tr key={f}>
                <td>{FEATURE_INFO[f].label}</td>
                <td className="num">{signed(MODEL.weights[f], 2)}</td>
                <td className="num">×{Math.exp(MODEL.weights[f] * per).toFixed(2)}</td>
                <td className="small muted">
                  {per === 0.1
                    ? '0.1 more debt ratio'
                    : per === 10
                      ? '£10k more income'
                      : `1 more ${f === 'years' ? 'year' : 'missed payment'}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Permutation importance as bars, with the spread across five shuffles. */
export function Importance() {
  const imp = useMemo(() => permutationImportance(), []);
  const max = Math.max(...imp.map((i) => i.max));
  return (
    <div className="card">
      {imp.map((i) => (
        <div key={i.feature} className="in-bar-row">
          <span className="in-bar-label">{FEATURE_INFO[i.feature].label}</span>
          <span className="in-bar-track">
            <span className="in-bar" style={{ width: `${(i.drop / max) * 100}%` }} />
            <span
              className="in-whisker"
              style={{ left: `${(i.min / max) * 100}%`, width: `${((i.max - i.min) / max) * 100}%` }}
            />
          </span>
          <span className="in-bar-value mono">−{i.drop.toFixed(3)}</span>
        </div>
      ))}
      <p className="small muted">
        Fall in AUC (0.795 with nothing shuffled) when each column is shuffled, averaged over five shuffles; the thin
        line is the range.
      </p>
    </div>
  );
}

/** Partial dependence with ICE curves for 30 applicants underneath. */
export function PartialDependence() {
  const [feature, setFeature] = useState<Feature>('income');
  const pd = useMemo(() => partialDependence(feature), [feature]);
  const ice = useMemo(
    () =>
      iceCurves(
        feature,
        POPULATION.filter((_, i) => i % 20 === 0),
      ),
    [feature],
  );
  const { min, max } = FEATURE_INFO[feature];
  const W = 560;
  const H = 240;
  const L = 44;
  const B = 30;
  const x = (v: number) => L + ((v - min) / (max - min)) * (W - L - 12);
  const y = (p: number) => 10 + (1 - p) * (H - B - 10);
  const line = (pts: [number, number][]) =>
    pts.map(([a, b], i) => `${i ? 'L' : 'M'}${x(a).toFixed(1)} ${y(b).toFixed(1)}`).join('');
  return (
    <div className="card">
      <div className="chips" role="group" aria-label="Feature">
        {FEATURES.map((f) => (
          <button
            key={f}
            type="button"
            className={`chip-btn${f === feature ? ' on' : ''}`}
            onClick={() => setFeature(f)}
          >
            {FEATURE_INFO[f].label}
          </button>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="in-chart"
        role="img"
        aria-label={`Partial dependence on ${FEATURE_INFO[feature].label}`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line x1={L} x2={W - 12} y1={y(p)} y2={y(p)} className="in-grid" />
            <text x={L - 6} y={y(p) + 4} textAnchor="end" className="in-axis">
              {p.toFixed(2)}
            </text>
          </g>
        ))}
        {ice.map((c, i) => (
          <path key={i} d={line(c)} className="in-ice" />
        ))}
        <path d={line(pd)} className="in-pd" />
        <text x={L} y={H - 8} className="in-axis">
          {fmt(feature, min)}
        </text>
        <text x={W - 12} y={H - 8} textAnchor="end" className="in-axis">
          {fmt(feature, max)}
        </text>
        <text x={(L + W) / 2} y={H - 8} textAnchor="middle" className="in-axis">
          {FEATURE_INFO[feature].label} ({FEATURE_INFO[feature].unit})
        </text>
      </svg>
      <p className="small muted">
        Bold: partial dependence, the average predicted chance of repaying as everyone’s{' '}
        {FEATURE_INFO[feature].label.toLowerCase()} is set to each value. Thin: the same sweep for 30 individual
        applicants (ICE curves). In a logistic model the curves never cross, but they are steepest for applicants near
        the middle, where a change moves the decision most.
      </p>
    </div>
  );
}

/** One applicant: sliders, the prediction, the Shapley waterfall, the coalitions and the counterfactuals. */
export function Explainer() {
  const [x, setX] = useState<Point>(SAMPLE);
  const [threshold, setThreshold] = useState(0.5);
  const s = useMemo(() => shapley(x), [x]);
  const cfs = counterfactuals(x, threshold);
  const p = predict(x);
  const approved = p >= threshold;

  // The waterfall: from the baseline, each feature's share, to the prediction.
  const W = 560;
  const rowH = 30;
  const L = 130;
  const ordered = [...FEATURES].sort((a, b) => Math.abs(s.phi[b]) - Math.abs(s.phi[a]));
  const steps: { label: string; from: number; to: number }[] = [];
  let at = s.base;
  for (const f of ordered) {
    steps.push({ label: `${FEATURE_INFO[f].label} = ${fmt(f, x[f])}`, from: at, to: at + s.phi[f] });
    at += s.phi[f];
  }
  const xs = (v: number) => L + v * (W - L - 50);
  const H = (steps.length + 2) * rowH + 10;

  return (
    <div className="grid2 in-explainer">
      <div className="card">
        {FEATURES.map((f) => {
          const info = FEATURE_INFO[f];
          return (
            <label key={f} className="in-slider">
              <span>
                {info.label}: <b>{fmt(f, x[f])}</b> <span className="muted">{info.unit}</span>
              </span>
              <input
                type="range"
                min={info.min}
                max={info.max}
                step={info.step}
                value={x[f]}
                onChange={(e) => setX((old) => ({ ...old, [f]: Number(e.target.value) }))}
              />
            </label>
          );
        })}
        <label className="in-slider">
          <span>
            Approval threshold: <b>{threshold.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0.2}
            max={0.8}
            step={0.01}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        <div className="row">
          <div className="stat">
            <div className="v">{pct(p, 1)}</div>
            <div className="k">predicted chance of repaying</div>
          </div>
          <div className="stat">
            <div className={`v ${approved ? 'in-good' : 'in-bad'}`}>{approved ? 'Approve' : 'Decline'}</div>
            <div className="k">at threshold {threshold.toFixed(2)}</div>
          </div>
        </div>
        <button type="button" className="btn small" onClick={() => setX(SAMPLE)}>
          Back to the sample applicant
        </button>
      </div>
      <div className="card">
        <h3 className="in-flush">Why this score: Shapley values</h3>
        <svg viewBox={`0 0 ${W} ${H}`} className="in-chart" role="img" aria-label="Shapley waterfall">
          <text x={L - 8} y={rowH - 8} textAnchor="end" className="in-axis">
            Average applicant
          </text>
          <line x1={xs(s.base)} x2={xs(s.base)} y1={rowH - 20} y2={H - rowH} className="in-grid" />
          <text x={xs(s.base) + 4} y={rowH - 8} className="in-axis">
            {s.base.toFixed(3)}
          </text>
          {steps.map((st, i) => {
            const y0 = (i + 1) * rowH + 4;
            const lo = Math.min(st.from, st.to);
            const hi = Math.max(st.from, st.to);
            return (
              <g key={st.label}>
                <text x={L - 8} y={y0 + 15} textAnchor="end" className="in-axis">
                  {st.label}
                </text>
                <rect
                  x={xs(lo)}
                  y={y0}
                  width={Math.max(1, xs(hi) - xs(lo))}
                  height={rowH - 10}
                  className={st.to >= st.from ? 'in-up' : 'in-down'}
                />
                <text x={xs(hi) + 4} y={y0 + 15} className="in-axis">
                  {signed(st.to - st.from)}
                </text>
              </g>
            );
          })}
          <text x={L - 8} y={(steps.length + 1) * rowH + 20} textAnchor="end" className="in-axis in-strong">
            This applicant
          </text>
          <line
            x1={xs(s.prediction)}
            x2={xs(s.prediction)}
            y1={rowH}
            y2={(steps.length + 1) * rowH + 24}
            className="in-pred"
          />
          <text x={xs(s.prediction) + 4} y={(steps.length + 1) * rowH + 20} className="in-axis in-strong">
            {s.prediction.toFixed(3)}
          </text>
        </svg>
        <p className="small muted">
          The bars add up exactly: {s.base.toFixed(3)} {FEATURES.map((f) => signed(s.phi[f])).join(' ')} ={' '}
          {s.prediction.toFixed(3)}.
        </p>
        <details>
          <summary className="small">The 16 coalitions behind it</summary>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Features taken from this applicant</th>
                  <th className="num">Average prediction</th>
                </tr>
              </thead>
              <tbody>
                {s.coalitions.map((c) => (
                  <tr key={c.members.join(',') || 'none'}>
                    <td>
                      {c.members.length
                        ? c.members.map((m) => FEATURE_INFO[m].label).join(', ')
                        : 'none (the baseline)'}
                    </td>
                    <td className="num">{c.value.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            A feature’s Shapley value is its average contribution when it joins each of these coalitions, weighted so
            every order of joining counts equally. Features not in a coalition take their values from 150 background
            applicants in turn.
          </p>
        </details>
      </div>
      <div className="card in-wide">
        <h3 className="in-flush">What would change the decision</h3>
        {approved ? (
          <p className="small">
            Approved at this threshold. Move the sliders until the decision flips to see the counterfactuals.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Change one thing</th>
                  <th className="num">From</th>
                  <th className="num">To</th>
                  <th>Can the applicant act on it?</th>
                </tr>
              </thead>
              <tbody>
                {cfs.map((c) => (
                  <tr key={c.feature}>
                    <td>{FEATURE_INFO[c.feature].label}</td>
                    <td className="num">{fmt(c.feature, x[c.feature])}</td>
                    <td className="num">{c.possible ? fmt(c.feature, c.needed) : 'out of range'}</td>
                    <td className="small">
                      <span className={c.actionable && c.possible ? 'in-good' : 'in-bad'}>
                        {c.actionable && c.possible ? 'Yes. ' : 'No. '}
                      </span>
                      {c.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const GROUPS: Group[] = ['North', 'South'];

/** Group fairness metrics with a threshold per group, and calibration by group. */
export function Fairness() {
  const [t, setT] = useState<Record<Group, number>>({ North: 0.5, South: 0.5 });
  const stats = groupStats(POPULATION, t);
  const g = gaps(stats);
  const bins = useMemo(() => calibration(), []);
  const best = useMemo(() => bestOfAllThree(), []);
  const presets: [string, () => Record<Group, number>][] = [
    ['Same threshold', () => ({ North: 0.5, South: 0.5 })],
    ['Equal approval rates', () => ({ North: 0.5, South: matchThreshold('parity', 0.5) })],
    ['Equal opportunity', () => ({ North: 0.5, South: matchThreshold('opportunity', 0.5) })],
    ['Equal precision', () => ({ North: 0.5, South: matchThreshold('predictive', 0.5) })],
    ['Closest to all three', () => ({ North: best.north, South: best.south })],
  ];
  const rows: [string, keyof (typeof stats)[number], string][] = [
    ['Repaid (base rate)', 'baseRate', 'what actually happened'],
    ['Approved', 'selection', 'demographic parity compares this'],
    ['Approved among repayers (TPR)', 'tpr', 'equal opportunity compares this'],
    ['Approved among defaulters (FPR)', 'fpr', 'equalised odds adds this'],
    ['Repaid among approved (precision)', 'ppv', 'predictive parity compares this'],
  ];
  const gapRows: [string, number][] = [
    ['Demographic parity: approval-rate gap', g.parity],
    ['Equal opportunity: TPR gap', g.opportunity],
    ['Equalised odds: larger of the TPR and FPR gaps', g.odds],
    ['Predictive parity: precision gap', g.predictive],
  ];
  return (
    <>
      <div className="card">
        <div className="grid2">
          {GROUPS.map((grp) => (
            <label key={grp} className="in-slider">
              <span>
                {grp} threshold: <b>{t[grp].toFixed(2)}</b>
              </span>
              <input
                type="range"
                min={0.1}
                max={0.9}
                step={0.01}
                value={t[grp]}
                onChange={(e) => setT((old) => ({ ...old, [grp]: Number(e.target.value) }))}
              />
            </label>
          ))}
        </div>
        <div className="chips">
          {presets.map(([label, f]) => (
            <button key={label} type="button" className="chip-btn" onClick={() => setT(f())}>
              {label}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Rate</th>
                {stats.map((s) => (
                  <th key={s.group} className="num">
                    {s.group} ({s.n})
                  </th>
                ))}
                <th>Used by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, key, note]) => (
                <tr key={key}>
                  <td>{label}</td>
                  {stats.map((s) => (
                    <td key={s.group} className="num">
                      {pct(s[key] as number)}
                    </td>
                  ))}
                  <td className="small muted">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="in-gaps">
          {gapRows.map(([label, v]) => (
            <li key={label}>
              <span className={v <= 0.03 ? 'in-good' : 'in-bad'}>{v <= 0.03 ? '●' : '○'}</span> {label}:{' '}
              <b>{(v * 100).toFixed(1)} points</b>
            </li>
          ))}
        </ul>
        <p className="small muted">
          A filled dot means the gap is within 3 points. Try each preset: closing one gap opens another. Over every pair
          of thresholds, the closest this model gets to equal precision and equalised odds together is a{' '}
          {(best.gap * 100).toFixed(1)}-point gap, because North repays more often than South.
        </p>
      </div>
      <h3>Calibration by group</h3>
      <p className="small">
        Calibration asks whether a score means the same thing for everyone: of the people given about 30%, do about 30%
        repay, in each group? Bands with fewer than eight people are left blank.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Predicted band</th>
              {GROUPS.map((grp) => (
                <th key={grp} className="num">
                  {grp}: predicted → observed
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bins.map((b) => (
              <tr key={b.lo}>
                <td>
                  {pct(b.lo)} to {pct(b.hi)}
                </td>
                {GROUPS.map((grp) => (
                  <td key={grp} className="num">
                    {b.predicted[grp] === null ? '–' : `${pct(b.predicted[grp]!)} → ${pct(b.observed[grp]!)}`}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** How the area leaks in through other features, and what dropping the strongest proxy does. */
export function Proxy() {
  const r = useMemo(() => proxyReport('years'), []);
  return (
    <div className="grid2">
      <div className="card">
        <h3 className="in-flush">Correlation with living in South</h3>
        {FEATURES.map((f) => (
          <div key={f} className="in-bar-row">
            <span className="in-bar-label">{FEATURE_INFO[f].label}</span>
            <span className="in-bar-track">
              <span className="in-bar" style={{ width: `${Math.min(100, Math.abs(r.correlations[f]) * 200)}%` }} />
            </span>
            <span className="in-bar-value mono">{signed(r.correlations[f], 2)}</span>
          </div>
        ))}
        <p className="small muted">The area is never an input, but years at address and income carry part of it.</p>
      </div>
      <div className="card">
        <h3 className="in-flush">Dropping years at address</h3>
        <div className="stats">
          <div className="stat">
            <div className="v">
              {(r.approvalGap * 100).toFixed(1)} → {(r.approvalGapWithout * 100).toFixed(1)}
            </div>
            <div className="k">approval gap, North minus South (points)</div>
          </div>
          <div className="stat">
            <div className="v">
              {r.aucWith.toFixed(3)} → {r.aucWithout.toFixed(3)}
            </div>
            <div className="k">AUC</div>
          </div>
        </div>
        <p className="small">
          The model weighs years at address far more than the outcomes justify, so it was mostly standing in for the
          area. Dropping it nearly halves the gap and costs almost nothing. The gap that is left comes from income,
          which does predict repayment: whether that is acceptable is a policy decision, not a modelling one.
        </p>
      </div>
    </div>
  );
}

/** A fillable model card or datasheet that renders as Markdown. */
export function DocForm() {
  const [kind, setKind] = useState<'card' | 'sheet'>('card');
  const doc: DocSection[] = kind === 'card' ? MODEL_CARD : DATASHEET;
  const title = kind === 'card' ? 'Model card: loan-repay v3' : 'Datasheet: approved personal loans';
  const [answers, setAnswers] = useState<Record<'card' | 'sheet', Answers>>({ card: {}, sheet: {} });
  const mine = answers[kind];
  const md = renderMarkdown(title, doc, mine);
  const { done, total } = answered(doc, mine);
  const set = (a: Answers) => setAnswers((old) => ({ ...old, [kind]: a }));
  return (
    <div className="card">
      <div className="row">
        <div className="chips" role="group" aria-label="Document">
          <button type="button" className={`chip-btn${kind === 'card' ? ' on' : ''}`} onClick={() => setKind('card')}>
            Model card
          </button>
          <button type="button" className={`chip-btn${kind === 'sheet' ? ' on' : ''}`} onClick={() => setKind('sheet')}>
            Datasheet
          </button>
        </div>
        <span className="spacer" />
        <span className="small muted">
          {done} of {total} answered
        </span>
        <button type="button" className="btn small" onClick={() => set(exampleAnswers(doc))}>
          Fill the worked example
        </button>
        <button type="button" className="btn small" onClick={() => set({})}>
          Clear
        </button>
      </div>
      <div className="grid2">
        <div>
          {doc.map((s) => (
            <fieldset key={s.heading} className="in-fieldset">
              <legend>{s.heading}</legend>
              {s.fields.map((f) => (
                <label key={f.key} className="in-field">
                  <span>{f.label}</span>
                  <textarea
                    rows={2}
                    value={mine[f.key] ?? ''}
                    onChange={(e) => set({ ...mine, [f.key]: e.target.value })}
                  />
                  <span className="small muted">{f.hint}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <div>
          <p className="small muted">The Markdown, ready to keep next to the model or the data:</p>
          <CodeBlock html={escape(md)} className="in-md" />
        </div>
      </div>
    </div>
  );
}
