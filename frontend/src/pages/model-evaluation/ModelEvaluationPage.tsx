import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { CourseSection, Quiz, SectionNav, WhereUsed } from '../tuning/parts';
import { Key, Plot } from '../tuning/plot';
import {
  assignFolds,
  auc,
  cheapestThreshold,
  complexityCurve,
  confusion,
  foldSensitivities,
  gains,
  imbalanced,
  imbalanceExperiment,
  learningCurve,
  metrics,
  positivesPerFold,
  prCurve,
  repeatedCv,
  rocCurve,
  screening,
  selectionOptimism,
  timeSeriesSplits,
  totalCost,
  type Method,
} from './evaluation';
import { QUIZ } from './quiz';
import './model-evaluation.css';

/*
  Evaluating models honestly, weeks 6 to 8 of the lab's course: splits and generalisation, the measures of a
  classifier at a threshold, cross-validation, class imbalance and leakage. All data is invented (evaluation.ts).
*/

const SECTIONS: [string, string][] = [
  ['splits', 'Three splits'],
  ['curves', 'Learning and complexity'],
  ['threshold', 'Measuring a classifier'],
  ['rare', 'When accuracy lies'],
  ['cv', 'Cross-validation'],
  ['nested', 'Nested CV'],
  ['imbalance', 'Imbalance and leakage'],
  ['time', 'Time order'],
  ['code', 'Code'],
  ['quiz', 'Check yourself'],
];

const pct = (x: number | null, digits = 1) => (x === null ? 'n/a' : `${(x * 100).toFixed(digits)}%`);

/* ---------- Why three splits ---------- */

function Selection() {
  const [models, setModels] = useState(50);
  const [val, setVal] = useState(200);
  const r = useMemo(() => selectionOptimism(models, val, 5000, 0.8, 1), [models, val]);
  return (
    <div className="card">
      <div className="me-bar" aria-hidden="true">
        <span className="tr">Training 60%: fit the parameters</span>
        <span className="va">Validation 20%: choose</span>
        <span className="te">Test 20%: report once</span>
      </div>
      <p>
        Below, every model is equally good: each would be right 80% of the time on new data. You score them all on one
        validation set and keep the best.
      </p>
      <div className="cs-controls">
        <label className="cs-field">
          <span>Models compared: {models}</span>
          <input type="range" min={1} max={200} value={models} onChange={(e) => setModels(+e.target.value)} />
        </label>
        <label className="cs-field">
          <span>Validation rows: {val}</span>
          <input type="range" min={50} max={2000} step={50} value={val} onChange={(e) => setVal(+e.target.value)} />
        </label>
      </div>
      <div className="stats">
        <div className="stat">
          <div className="v">{pct(r.bestVal)}</div>
          <div className="k">best validation score (what you would be tempted to report)</div>
        </div>
        <div className="stat">
          <div className="v">{pct(r.test)}</div>
          <div className="k">the same model on an untouched test set</div>
        </div>
        <div className="stat">
          <div className="v">{((r.bestVal - r.test) * 100).toFixed(1)} pts</div>
          <div className="k">optimism from choosing</div>
        </div>
      </div>
      <p className="small muted">Averaged over 40 repeats. More models or a smaller validation set: more optimism.</p>
    </div>
  );
}

/* ---------- Learning and complexity curves ---------- */

const SIZES = [12, 20, 30, 50, 80, 130, 200, 320];
const DEGREES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12];

function Curves() {
  const [degree, setDegree] = useState(9);
  const [n, setN] = useState(30);
  const lc = useMemo(() => learningCurve(degree, SIZES), [degree]);
  const cc = useMemo(() => complexityCurve(n, DEGREES), [n]);
  const cap = (v: number) => Math.min(v, 1.2);
  const bestDegree = cc.reduce((a, b) => (b.val < a.val ? b : a)).degree;
  return (
    <div className="grid2">
      <div className="card">
        <h3 className="me-flush">Learning curve</h3>
        <div className="chips" role="group" aria-label="Model flexibility">
          {[
            [1, 'Straight line'],
            [3, 'Cubic'],
            [9, 'Degree 9'],
          ].map(([d, name]) => (
            <button
              key={d}
              type="button"
              className={`chip-btn${degree === d ? ' on' : ''}`}
              aria-pressed={degree === d}
              onClick={() => setDegree(d as number)}
            >
              {name}
            </button>
          ))}
        </div>
        <Plot
          aria="Training and validation error against training-set size"
          xDomain={[0, 320]}
          yDomain={[0, 1.2]}
          xLabel="training rows"
          yLabel="mean squared error"
          series={[
            { points: lc.map((p) => [p.n, cap(p.train)]), cls: 'pl-s1' },
            { points: lc.map((p) => [p.n, cap(p.val)]), cls: 'pl-s2' },
          ]}
          hlines={[{ at: 0.09, cls: 'pl-muted', label: 'noise floor' }]}
        />
        <div className="pl-legend">
          <Key cls="pl-s1">training error</Key>
          <Key cls="pl-s2">validation error</Key>
        </div>
        <p className="small">
          {degree === 1
            ? 'A straight line cannot bend to the curve. Both errors settle well above the noise floor and more data does not help: high bias.'
            : degree === 3
              ? 'A cubic has about the right flexibility: the gap closes quickly and both errors approach the noise floor.'
              : 'Degree 9 fits noise in small samples: training error is tiny, validation error huge. The gap shrinks as data grows: high variance.'}
        </p>
      </div>
      <div className="card">
        <h3 className="me-flush">Complexity curve</h3>
        <label className="cs-field">
          <span>Training rows: {n}</span>
          <input type="range" min={15} max={200} step={5} value={n} onChange={(e) => setN(+e.target.value)} />
        </label>
        <Plot
          aria="Training and validation error against polynomial degree"
          xDomain={[0, 12]}
          yDomain={[0, 1.2]}
          xLabel="polynomial degree (flexibility)"
          yLabel="mean squared error"
          series={[
            { points: cc.map((p) => [p.degree, cap(p.train)]), cls: 'pl-s1' },
            { points: cc.map((p) => [p.degree, cap(p.val)]), cls: 'pl-s2' },
          ]}
          vlines={[{ at: bestDegree, cls: 'pl-good', label: 'lowest validation error' }]}
        />
        <p className="small">
          Training error only ever falls as flexibility grows, so it cannot choose the model. Validation error falls,
          bottoms out (here at degree {bestDegree}) and rises again. With more rows, the rise starts later.
        </p>
      </div>
    </div>
  );
}

/* ---------- A classifier at a threshold ---------- */

function Threshold() {
  const [prev, setPrev] = useState(0.1);
  const [t, setT] = useState(0.5);
  const [costFn, setCostFn] = useState(20);
  const [costFp, setCostFp] = useState(1);
  const d = useMemo(() => screening(2000, prev, 7), [prev]);
  const c = confusion(d, t);
  const m = metrics(c);
  const roc = useMemo(() => rocCurve(d), [d]);
  const pr = useMemo(() => prCurve(d), [d]);
  const g = useMemo(() => gains(d), [d]);
  const area = useMemo(() => auc(d), [d]);
  const cheapest = cheapestThreshold(d, { fn: costFn, fp: costFp });
  const positives = c.tp + c.fn;
  return (
    <div className="card">
      <p>
        An invented screening test gives 2,000 people a score between 0 and 1. People with the condition tend to score
        higher, but the two groups overlap. Anyone at or above the threshold is sent for a follow-up test.
      </p>
      <div className="cs-controls">
        <div className="chips" role="group" aria-label="How common the condition is">
          {[0.1, 0.01].map((p) => (
            <button
              key={p}
              type="button"
              className={`chip-btn${prev === p ? ' on' : ''}`}
              aria-pressed={prev === p}
              onClick={() => setPrev(p)}
            >
              {p * 100}% have the condition
            </button>
          ))}
        </div>
        <label className="cs-field">
          <span>Threshold: {t.toFixed(2)}</span>
          <input type="range" min={0} max={1} step={0.01} value={t} onChange={(e) => setT(+e.target.value)} />
        </label>
      </div>
      <div className="me-cm-wrap">
        <table className="me-cm" aria-label="Confusion matrix">
          <thead>
            <tr>
              <th />
              <th>Called positive</th>
              <th>Called negative</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Has the condition ({positives})</th>
              <td className="ok">
                <b>{c.tp}</b>
                <span>true positives</span>
              </td>
              <td className="miss">
                <b>{c.fn}</b>
                <span>false negatives: missed</span>
              </td>
            </tr>
            <tr>
              <th>Does not ({c.tn + c.fp})</th>
              <td className="miss">
                <b>{c.fp}</b>
                <span>false positives: needless follow-up</span>
              </td>
              <td className="ok">
                <b>{c.tn}</b>
                <span>true negatives</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="stats">
        <div className="stat">
          <div className="v">{pct(m.accuracy)}</div>
          <div className="k">accuracy: (TP + TN) ÷ all</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.sensitivity)}</div>
          <div className="k">sensitivity (recall): TP ÷ (TP + FN)</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.specificity)}</div>
          <div className="k">specificity: TN ÷ (TN + FP)</div>
        </div>
        <div className="stat">
          <div className="v">{pct(m.precision)}</div>
          <div className="k">precision: TP ÷ (TP + FP)</div>
        </div>
        <div className="stat">
          <div className="v">{m.f1 === null ? 'n/a' : m.f1.toFixed(3)}</div>
          <div className="k">F1: harmonic mean of precision and recall</div>
        </div>
      </div>
      <div className="grid3">
        <div>
          <h3>ROC curve (AUC {area.toFixed(3)})</h3>
          <Plot
            aria="ROC curve with the current threshold marked"
            xDomain={[0, 1]}
            yDomain={[0, 1]}
            width={320}
            height={280}
            xLabel="false positive rate"
            yLabel="true positive rate"
            series={[
              {
                points: [
                  [0, 0],
                  [1, 1],
                ],
                cls: 'pl-muted',
                dashed: true,
              },
              { points: roc, cls: 'pl-s1' },
            ]}
            markers={[{ x: 1 - m.specificity, y: m.sensitivity, cls: 'pl-bad', r: 6 }]}
          />
        </div>
        <div>
          <h3>Precision and recall</h3>
          <Plot
            aria="Precision–recall curve with the current threshold marked"
            xDomain={[0, 1]}
            yDomain={[0, 1]}
            width={320}
            height={280}
            xLabel="recall (sensitivity)"
            yLabel="precision"
            series={[{ points: pr, cls: 'pl-s3' }]}
            hlines={[{ at: prev, cls: 'pl-muted', label: 'chance' }]}
            markers={m.precision === null ? [] : [{ x: m.sensitivity, y: m.precision, cls: 'pl-bad', r: 6 }]}
          />
        </div>
        <div>
          <h3>Cumulative gains</h3>
          <Plot
            aria="Cumulative gains: share of positives found against share of people contacted, highest scores first"
            xDomain={[0, 1]}
            yDomain={[0, 1]}
            width={320}
            height={280}
            xLabel="share contacted, highest scores first"
            yLabel="share of positives found"
            fmtX={(v) => `${Math.round(v * 100)}%`}
            fmtY={(v) => `${Math.round(v * 100)}%`}
            series={[
              {
                points: [
                  [0, 0],
                  [1, 1],
                ],
                cls: 'pl-muted',
                dashed: true,
              },
              { points: g.map((p) => [p.contacted, p.captured]), cls: 'pl-s4' },
            ]}
          />
          <p className="small">
            Lift at the top 10%: <b>{g[2].lift.toFixed(1)}×</b>; at the top 20%: <b>{g[4].lift.toFixed(1)}×</b>.
          </p>
        </div>
      </div>
      <h3>Choose the threshold by cost</h3>
      <p>
        The right threshold depends on what each mistake costs. Put a cost on a missed case and on a needless follow-up,
        and the page finds the threshold with the lowest total cost.
      </p>
      <div className="cs-controls">
        <label className="cs-field">
          <span>Cost of a missed case</span>
          <input type="number" min={0} value={costFn} onChange={(e) => setCostFn(Math.max(0, +e.target.value || 0))} />
        </label>
        <label className="cs-field">
          <span>Cost of a needless follow-up</span>
          <input type="number" min={0} value={costFp} onChange={(e) => setCostFp(Math.max(0, +e.target.value || 0))} />
        </label>
        <button type="button" className="btn primary" onClick={() => setT(cheapest.threshold)}>
          Move to the cheapest threshold ({cheapest.threshold.toFixed(2)})
        </button>
      </div>
      <p className="small">
        At {t.toFixed(2)} the total cost is <b>{totalCost(c, { fn: costFn, fp: costFp }).toLocaleString('en-GB')}</b>;
        the lowest possible is <b>{cheapest.cost.toLocaleString('en-GB')}</b>.
      </p>
    </div>
  );
}

/* ---------- Cross-validation ---------- */

const CV_DATA = screening(100, 0.15, 5);

function CrossValidation() {
  const [stratified, setStratified] = useState(false);
  const [seed, setSeed] = useState(4);
  const [k, setK] = useState(5);
  const folds = assignFolds(CV_DATA.labels, k, stratified, seed);
  const pos = positivesPerFold(CV_DATA.labels, folds, k);
  const sens = foldSensitivities(CV_DATA, folds, k);
  const rep = useMemo(
    () => ({ plain: repeatedCv(CV_DATA, k, 10, false), strat: repeatedCv(CV_DATA, k, 10, true) }),
    [k],
  );
  const side = 10;
  const cell = 26;
  return (
    <div className="card">
      <div className="cs-controls">
        <div className="chips" role="group" aria-label="How rows are dealt into folds">
          {[
            [false, 'Plain k-fold'],
            [true, 'Stratified k-fold'],
          ].map(([v, name]) => (
            <button
              key={String(v)}
              type="button"
              className={`chip-btn${stratified === v ? ' on' : ''}`}
              aria-pressed={stratified === v}
              onClick={() => setStratified(v as boolean)}
            >
              {name as string}
            </button>
          ))}
        </div>
        <label className="cs-field">
          <span>Folds k: {k}</span>
          <input type="range" min={3} max={5} value={k} onChange={(e) => setK(+e.target.value)} />
        </label>
        <button type="button" className="btn small" onClick={() => setSeed((s) => s + 1)}>
          Shuffle again
        </button>
      </div>
      <div className="me-cv">
        <svg
          viewBox={`0 0 ${side * cell} ${side * cell}`}
          className="me-folds"
          role="img"
          aria-label="One hundred rows coloured by fold; rows with the condition are marked with a dark centre"
        >
          {folds.map((f, i) => (
            <g key={i}>
              <rect
                x={(i % side) * cell + 2}
                y={Math.floor(i / side) * cell + 2}
                width={cell - 4}
                height={cell - 4}
                rx={4}
                className={`me-f${f}`}
              />
              {CV_DATA.labels[i] === 1 && (
                <circle
                  cx={(i % side) * cell + cell / 2}
                  cy={Math.floor(i / side) * cell + cell / 2}
                  r={5}
                  className="me-pos"
                />
              )}
            </g>
          ))}
        </svg>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Fold</th>
                <th className="num">Rows</th>
                <th className="num">With the condition</th>
                <th className="num">Sensitivity on this fold</th>
              </tr>
            </thead>
            <tbody>
              {pos.map((p, f) => (
                <tr key={f}>
                  <td>
                    <span className={`me-swatch me-f${f}`} /> {f + 1}
                  </td>
                  <td className="num">{folds.filter((v) => v === f).length}</td>
                  <td className="num">{p}</td>
                  <td className="num">{sens[f] === null ? 'cannot score' : pct(sens[f], 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p>
        Each fold takes a turn as the held-out set while the model trains on the rest, so every row is scored once. With
        15 positives in 100 rows, plain shuffling often leaves one fold with very few, and that fold&apos;s sensitivity
        swings. Stratifying deals the positives out evenly.
      </p>
      <p>
        Repeated 10 times with new shuffles: fold scores spread by <b>{pct(rep.plain.sdOfFolds, 0)}</b> (plain) against{' '}
        <b>{pct(rep.strat.sdOfFolds, 0)}</b> (stratified), and each run&apos;s mean moves by about{' '}
        <b>{pct(rep.strat.sdOfRunMeans, 1)}</b> from one shuffle to the next. Report the mean with that spread, not a
        single fold.
      </p>
    </div>
  );
}

/* ---------- Imbalance and leakage ---------- */

const IMB = imbalanced(600, 0.06, 2);
const METHODS: [Method, string, string][] = [
  ['none', 'Nothing', 'Train on the data as it is: the rare class is outvoted.'],
  ['under', 'Undersample', 'Drop negatives at random until the classes match. Throws data away.'],
  ['over', 'Oversample', 'Copy positives at random until the classes match. Easy to overfit to the copies.'],
  ['smote', 'SMOTE-style', 'Make new positives between a positive and a near positive neighbour.'],
  ['weights', 'Class weights', 'Keep the data; count each positive vote as much as the imbalance.'],
];

function Imbalance() {
  const rows = useMemo(
    () =>
      METHODS.map(([m, name, how]) => ({
        m,
        name,
        how,
        right: imbalanceExperiment(IMB, m, false),
        leaky: m === 'none' || m === 'weights' ? null : imbalanceExperiment(IMB, m, true),
      })),
    [],
  );
  return (
    <div className="card">
      <p>
        600 invented rows, 6% positive, two features, and a 7-nearest-neighbour classifier scored on a 30% stratified
        test set. Each method is run the right way (split first, resample the training rows only) and the leaky way
        (resample everything, then split).
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Method</th>
              <th className="num">Sensitivity</th>
              <th className="num">Precision</th>
              <th className="num">F1</th>
              <th className="num">Leaky sensitivity</th>
              <th className="num">Leaky precision</th>
              <th className="num">Test rows copied from training</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m}>
                <td>
                  <b>{r.name}</b>
                  <div className="small muted">{r.how}</div>
                </td>
                <td className="num">{pct(r.right.sensitivity, 0)}</td>
                <td className="num">{pct(r.right.precision, 0)}</td>
                <td className="num">{r.right.f1 === null ? 'n/a' : r.right.f1.toFixed(2)}</td>
                <td className={`num${r.leaky && r.leaky.sensitivity > r.right.sensitivity + 0.1 ? ' cs-bad' : ''}`}>
                  {r.leaky ? pct(r.leaky.sensitivity, 0) : '—'}
                </td>
                <td
                  className={`num${r.leaky && (r.leaky.precision ?? 0) > (r.right.precision ?? 0) + 0.1 ? ' cs-bad' : ''}`}
                >
                  {r.leaky ? pct(r.leaky.precision, 0) : '—'}
                </td>
                <td className="num">{r.leaky ? `${r.leaky.copiesInTest} of ${r.leaky.testRows}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Rebalancing trades precision for sensitivity; which is right depends on the costs, as in the threshold section.
        The leaky columns are the trap. Oversampling first puts copies of test positives into training, and a nearest
        neighbour finds its own copy. Undersampling first leaves a test set with half positives instead of 6%, so
        precision looks far better than it will be on real traffic. Resample inside the training data only, and in
        cross-validation inside each training fold: a pipeline (as in the code below) does that for you.
      </p>
    </div>
  );
}

/* ---------- Time order ---------- */

function TimeSplits() {
  const n = 60;
  const splits = timeSeriesSplits(n, 4);
  const W = 560;
  const rowH = 26;
  const x = (i: number) => 40 + (i / n) * (W - 50);
  return (
    <svg
      viewBox={`0 0 ${W} ${splits.length * rowH + 26}`}
      className="me-time"
      role="img"
      aria-label="Four expanding-window splits: each trains on everything before a point and tests on the block after it"
    >
      {splits.map((s, i) => (
        <g key={i}>
          <text x={4} y={i * rowH + 18} className="me-time-t">
            {i + 1}
          </text>
          <rect x={x(0)} y={i * rowH + 6} width={x(s.trainEnd) - x(0)} height={16} rx={3} className="me-time-train" />
          <rect
            x={x(s.trainEnd)}
            y={i * rowH + 6}
            width={x(s.testEnd) - x(s.trainEnd)}
            height={16}
            rx={3}
            className="me-time-test"
          />
        </g>
      ))}
      <text x={x(0)} y={splits.length * rowH + 20} className="me-time-t">
        earliest
      </text>
      <text x={x(n)} y={splits.length * rowH + 20} textAnchor="end" className="me-time-t">
        latest →
      </text>
    </svg>
  );
}

const CODE = `from imblearn.over_sampling import SMOTE
from imblearn.pipeline import Pipeline          # resamples inside each training fold only
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import (GridSearchCV, StratifiedKFold, TimeSeriesSplit,
                                     cross_val_score, train_test_split)
from sklearn.preprocessing import StandardScaler

# Hold out a test set first, stratified so it keeps the real share of positives.
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, stratify=y, random_state=0)

pipe = Pipeline([("scale", StandardScaler()),     # fitted on training rows only, fold by fold
                 ("smote", SMOTE(random_state=0)),
                 ("model", LogisticRegression(max_iter=1000))])

inner = StratifiedKFold(n_splits=5, shuffle=True, random_state=1)
outer = StratifiedKFold(n_splits=5, shuffle=True, random_state=2)
search = GridSearchCV(pipe, {"model__C": [0.01, 0.1, 1, 10]}, cv=inner, scoring="average_precision")

# Nested cross-validation: an honest estimate of "tune, then train" as a whole procedure.
nested = cross_val_score(search, X_train, y_train, cv=outer, scoring="average_precision")
print(f"nested CV: {nested.mean():.3f} ± {nested.std():.3f}")

# Then tune on all the training data, and touch the test set once.
search.fit(X_train, y_train)
proba = search.predict_proba(X_test)[:, 1]
print("test ROC AUC", roc_auc_score(y_test, proba))
print(classification_report(y_test, proba >= 0.5))

# Rows in time order: never shuffle; each split tests on later rows only.
for train_idx, test_idx in TimeSeriesSplit(n_splits=4).split(X_time):
    ...
`;

export default function ModelEvaluationPage() {
  return (
    <main className="page-model-evaluation">
      <p className="kicker">Course · weeks 6 to 8</p>
      <h1>Evaluating models honestly</h1>
      <p className="lede">
        A model is only as good as the evidence that it works on data it has not seen. This page covers how to get that
        evidence: splitting the data, reading learning curves, the measures of a classifier and how a threshold trades
        them, cross-validation, and the ways class imbalance and leakage make a model look better than it is. All the
        data is invented and everything runs in your browser.
      </p>
      <SectionNav sections={SECTIONS} />

      <CourseSection id="splits" title="Training, validation and test: why three" weeks={[6]}>
        <p>
          The model learns its parameters on the <b>training</b> set. You compare models and settings on the{' '}
          <b>validation</b> set. The <b>test</b> set is read once, at the end, for the number you report. The test set
          has to be separate because choosing by validation score fits the validation set a little: the more you
          compare, the luckier the winner&apos;s score.
        </p>
        <Selection />
      </CourseSection>

      <CourseSection id="curves" title="Generalisation: learning curves and model complexity" weeks={[6]}>
        <p>
          Polynomials of different degrees are fitted to noisy points from a smooth curve, and scored on a large
          separate validation set. Two plots tell you most of what you need. A <b>learning curve</b> shows error against
          the amount of training data, for one model. A <b>complexity curve</b> shows error against the model&apos;s
          flexibility, for one amount of data. The theory behind them, including double descent, is in the{' '}
          <Link to="/deep-learning">deep learning notebooks</Link> on the bias–variance trade-off.
        </p>
        <Curves />
      </CourseSection>

      <CourseSection id="threshold" title="Measuring a classifier at a threshold" weeks={[7]}>
        <Threshold />
        <p>
          Read the plots together. The ROC curve and its area describe how well the scores rank people, whatever the
          threshold. The precision–recall curve shows what calling someone positive is worth, which depends on how
          common the condition is. The gains chart answers a business question directly: if we can only follow up the
          top fifth, how many cases do we find? For whether a score of 0.8 really means an 80% chance, see{' '}
          <Link to="/confidence">confidence and calibration</Link>.
        </p>
      </CourseSection>

      <CourseSection id="rare" title="When accuracy lies" weeks={[7]}>
        <p>
          Switch the threshold demo above to <b>1% have the condition</b> and drag the threshold to 1. Nobody is called
          positive, nobody is found, and accuracy is still 99%. With rare positives, accuracy rewards doing nothing. Use
          sensitivity and precision (or the precision–recall curve), compare with the do-nothing baseline, and choose
          the threshold from the costs of each mistake.
        </p>
        <p>
          Notice too that the ROC AUC hardly changes between 10% and 1%, while precision at the same threshold falls
          sharply. At 1%, even a good test sends many well people for follow-up for every case it finds.
        </p>
      </CourseSection>

      <CourseSection id="cv" title="Cross-validation: using every row for both" weeks={[8]}>
        <p>
          With little data, one validation split is a coin toss. <b>k-fold cross-validation</b> cuts the training data
          into k folds; each takes a turn as the held-out fold. The result is k scores: their mean is the estimate and
          their spread says how much it depends on which rows were held out.
        </p>
        <CrossValidation />
      </CourseSection>

      <CourseSection id="nested" title="Nested cross-validation for model selection" weeks={[8]}>
        <p>
          If you tune hyperparameters with cross-validation and report the best cross-validated score, you have the same
          optimism as the three-splits demo: the score chose the settings. <b>Nested</b> cross-validation puts a second
          loop around the first. Each outer fold is held out while the inner loop tunes on the rest; the tuned model is
          then scored on the outer fold, which the tuning never saw.
        </p>
        <div className="me-nested" aria-label="Nested cross-validation">
          <div className="me-outer">
            <b>Outer loop</b>, 5 folds: an honest score of the whole procedure
            <div className="me-inner">
              <b>Inner loop</b>, on the outer training folds: try settings, pick the best by inner CV
            </div>
            <div className="me-inner held">Outer held-out fold: score the tuned model once</div>
          </div>
        </div>
        <p>
          The outer scores estimate how well &ldquo;tune, then train&rdquo; works, not one fixed model. Afterwards you
          still tune once on all the training data to get the model you ship. The tuning page shows the search itself:{' '}
          <Link to="/tuning">hyperparameter tuning</Link>.
        </p>
      </CourseSection>

      <CourseSection id="imbalance" title="Class imbalance, and why you resample inside the training fold" weeks={[8]}>
        <Imbalance />
      </CourseSection>

      <CourseSection id="time" title="Data in time order" weeks={[8]}>
        <p>
          When rows have a time order and the model will predict the future, never shuffle. Train on the past and test
          on the block that follows, then move forward. Shuffled folds let the model learn from the future it is meant
          to predict, so every score is too good.
        </p>
        <TimeSplits />
        <div className="pl-legend">
          <span className="pl-key">
            <i className="me-k-train" /> train
          </span>
          <span className="pl-key">
            <i className="me-k-test" /> test
          </span>
        </div>
      </CourseSection>

      <CourseSection id="code" title="The same in scikit-learn" weeks={[6, 7, 8]}>
        <CodeBlock html={highlight(CODE)} />
        <p className="small muted">
          <code>imblearn</code> is the imbalanced-learn package. Its pipeline applies SMOTE to training rows only, so
          cross-validation stays honest. For evaluating language models rather than classifiers, see the{' '}
          <Link to="/evals">evals lab</Link>.
        </p>
      </CourseSection>

      <CourseSection id="quiz" title="Check yourself" weeks={[6, 7, 8]}>
        <Quiz questions={QUIZ} />
      </CourseSection>

      <WhereUsed
        links={[
          ['/ml', 'Machine learning algorithms', 'every algorithm scored on a held-out set'],
          ['/tuning', 'Tuning and Bayesian optimisation', 'cross-validated scores drive the search'],
          ['/confidence', 'Confidence and calibration', 'whether a score means what it says'],
          ['/evals', 'Evals lab', 'the same discipline applied to language model outputs'],
          ['/mlops', 'MLOps', 'choosing a run by validation, then reading the test score once'],
          ['/tabular', 'Tabular foundation models', 'models compared on held-out rows'],
        ]}
      />
    </main>
  );
}
