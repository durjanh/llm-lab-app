import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { acquisition, fitGP, samplePosterior, type Acquisition } from './gp';
import { CourseSection, Quiz, SectionNav, WhereUsed } from './parts';
import { Key, Plot } from './plot';
import { QUIZ } from './quiz';
import {
  bayesSearch,
  distinctFirst,
  fullTraining,
  gridPoints,
  hidden2d,
  lossAt,
  makeConfigs,
  meanCurve,
  randomPoints,
  randomSearch,
  randomVersusGrid,
  successiveHalving,
  validationLoss,
  type Point,
} from './search';
import './tuning.css';

/*
  Hyperparameter tuning and Bayesian optimisation, weeks 14 and 18 of the lab's course. Everything runs in the
  browser on invented functions; the Gaussian process is written out in gp.ts and the searches in search.ts.
*/

const SECTIONS: [string, string][] = [
  ['what', 'Parameters and hyperparameters'],
  ['grid', 'Grid or random'],
  ['halving', 'Successive halving'],
  ['gp', 'A Gaussian process'],
  ['acq', 'Acquisition functions'],
  ['bo', 'Bayesian optimisation in 2D'],
  ['practice', 'In practice'],
  ['code', 'Code'],
  ['quiz', 'Check yourself'],
];

/* ---------- A heat map of a function on the unit square ---------- */

function Heat({
  f,
  lowIsGood,
  points,
  aria,
}: {
  f: (p: Point) => number;
  lowIsGood?: boolean;
  points: { p: Point; cls: string; label?: string; ring?: boolean }[];
  aria: string;
}) {
  const N = 36;
  const S = 300;
  const cells = useMemo(() => {
    const vals: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) vals.push(f([(i + 0.5) / N, (j + 0.5) / N]));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return vals.map((v) => {
      const t = (v - lo) / (hi - lo || 1);
      return lowIsGood ? 1 - t : t;
    });
  }, [f, lowIsGood]);
  const c = S / N;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="tu-heat" role="img" aria-label={aria}>
      {cells.map((t, k) => {
        const i = Math.floor(k / N);
        const j = k % N;
        return (
          <rect
            key={k}
            x={i * c}
            y={S - (j + 1) * c}
            width={c + 0.5}
            height={c + 0.5}
            className="tu-cell"
            fillOpacity={0.05 + 0.75 * t ** 1.5}
          />
        );
      })}
      {points.map((d, k) => (
        <circle
          key={k}
          cx={d.p[0] * S}
          cy={S - d.p[1] * S}
          r={d.ring ? 7 : 4.5}
          className={`tu-pt ${d.cls}${d.ring ? ' ring' : ''}`}
        >
          {d.label && <title>{d.label}</title>}
        </circle>
      ))}
    </svg>
  );
}

/* ---------- Grid against random ---------- */

function GridVersusRandom() {
  const [side, setSide] = useState(3);
  const [seed, setSeed] = useState(1);
  const grid = gridPoints(side);
  const rand = randomPoints(side * side, seed);
  const avg = useMemo(() => randomVersusGrid(side), [side]);
  const best = (pts: Point[]) => Math.min(...pts.map(validationLoss));
  return (
    <div className="card">
      <div className="cs-controls">
        <label className="cs-field">
          <span>Trials per search: {side * side}</span>
          <input type="range" min={2} max={5} value={side} onChange={(e) => setSide(+e.target.value)} />
        </label>
        <button type="button" className="btn small" onClick={() => setSeed((s) => s + 1)}>
          Draw new random trials
        </button>
      </div>
      <div className="grid2">
        <div>
          <h3 className="tu-flush">
            Grid: best loss {best(grid).toFixed(3)}, {distinctFirst(grid)} learning rates tried
          </h3>
          <Heat
            f={validationLoss}
            lowIsGood
            points={grid.map((p) => ({ p, cls: 'tu-grid', label: `loss ${validationLoss(p).toFixed(3)}` }))}
            aria="Validation loss over learning rate (across) and dropout (up), with the grid's trials"
          />
        </div>
        <div>
          <h3 className="tu-flush">
            Random: best loss {best(rand).toFixed(3)}, {distinctFirst(rand)} learning rates tried
          </h3>
          <Heat
            f={validationLoss}
            lowIsGood
            points={rand.map((p) => ({ p, cls: 'tu-rand', label: `loss ${validationLoss(p).toFixed(3)}` }))}
            aria="The same loss with the random search's trials"
          />
        </div>
      </div>
      <p className="small muted">
        Darker is lower loss. Across: learning rate on a log scale. Up: dropout. The dark band is vertical because
        dropout barely matters here.
      </p>
      <p>
        Over 200 random draws of {side * side} trials, random search averages a best loss of{' '}
        <b>{avg.random.toFixed(3)}</b> against the grid&apos;s <b>{avg.grid.toFixed(3)}</b>, and beats the grid{' '}
        <b>{Math.round(avg.randomWins * 100)}%</b> of the time.
      </p>
    </div>
  );
}

/* ---------- Successive halving ---------- */

function Halving() {
  const [n, setN] = useState(27);
  const [eta, setEta] = useState(3);
  const maxEpochs = 27;
  const configs = useMemo(() => makeConfigs(n, 3), [n]);
  const r = useMemo(() => successiveHalving(configs, 1, eta, maxEpochs, 5), [configs, eta]);
  const full = fullTraining(configs, r.totalEpochs, maxEpochs);
  const epochsAxis = Array.from({ length: maxEpochs }, (_, i) => i + 1);
  const finalists = new Set(r.rounds[r.rounds.length - 1].survivors);
  const stoppedAt = new Map<number, number>();
  r.rounds.forEach((round) => round.survivors.forEach((id) => stoppedAt.set(id, round.epochs)));
  return (
    <div className="card">
      <div className="cs-controls">
        <label className="cs-field">
          <span>Configurations: {n}</span>
          <select value={n} onChange={(e) => setN(+e.target.value)}>
            {[9, 27, 81].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="cs-field">
          <span>Keep 1 in η each round: η = {eta}</span>
          <input type="range" min={2} max={4} value={eta} onChange={(e) => setEta(+e.target.value)} />
        </label>
      </div>
      <Plot
        aria="Validation loss against epochs for every configuration, each line stopping where successive halving dropped it"
        xDomain={[1, maxEpochs]}
        yDomain={[0, 1]}
        xLabel="epochs trained"
        yLabel="validation loss"
        series={configs.map((c) => ({
          points: epochsAxis.filter((e) => e <= (stoppedAt.get(c.id) ?? 1)).map((e) => [e, lossAt(c, e, 5)]),
          cls: c.id === r.chosen.id ? 'pl-good' : finalists.has(c.id) ? 'pl-s1' : 'pl-muted',
          thin: c.id !== r.chosen.id && !finalists.has(c.id),
        }))}
        hlines={[{ at: r.bestPossible.final, cls: 'pl-s2', label: 'best any configuration could reach' }]}
      />
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Round</th>
              <th className="num">Configurations</th>
              <th className="num">Epochs each</th>
              <th>Best loss this round</th>
            </tr>
          </thead>
          <tbody>
            {r.rounds.map((round, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="num">{round.survivors.length}</td>
                <td className="num">{round.epochs}</td>
                <td>{Math.min(...round.losses).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Successive halving spent <b>{r.totalEpochs}</b> epochs and chose a configuration that ends at{' '}
        <b>{r.chosen.final.toFixed(3)}</b> (the best of all {n} ends at {r.bestPossible.final.toFixed(3)}). The same{' '}
        {r.totalEpochs} epochs would train only <b>{full.count}</b> configurations fully; the best of those ends at{' '}
        <b>{full.chosen.final.toFixed(3)}</b>.
      </p>
    </div>
  );
}

/* ---------- A Gaussian process in one dimension ---------- */

/** The invented 1D function the reader probes: two bumps on a slope. Its maximum is near x = 0.83. */
const g = (x: number) => 0.6 * Math.sin(9 * x) + 0.4 * Math.cos(23 * x) * x + 0.5 * x;
const XS = Array.from({ length: 121 }, (_, i) => i / 120);

function GaussianProcess() {
  const [obs, setObs] = useState<number[]>([0.15, 0.5, 0.9]);
  const [ls, setLs] = useState(0.1);
  const [noise, setNoise] = useState(0.001);
  const [showTruth, setShowTruth] = useState(false);
  const [showSamples, setShowSamples] = useState(true);
  const [kind, setKind] = useState<Acquisition>('ei');
  const [kappa, setKappa] = useState(2);

  // Each observation's noise is fixed by its position, so redrawing never changes a measured value.
  const measure = (x: number) => g(x) + Math.sqrt(noise) * Math.sin(x * 9973) * 0.8;
  const { ys, gp } = useMemo(() => {
    const measured = obs.map(measure);
    return {
      ys: measured,
      gp: fitGP(
        obs.map((x) => [x]),
        measured,
        { lengthScale: ls, signalVar: 1, noise },
      ),
    };
    // measure depends only on noise, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obs, ls, noise]);
  const post = XS.map((x) => gp.predict([x]));
  const samples = showSamples
    ? samplePosterior(
        gp,
        XS.filter((_, i) => i % 2 === 0),
        3,
        obs.length,
      )
    : [];
  const best = Math.max(...ys);
  const acq = post.map((p) => acquisition(kind, p, best, { kappa }));
  const iBest = acq.indexOf(Math.max(...acq));
  const next = XS[iBest];
  const acqMax = Math.max(...acq.map(Math.abs), 1e-9);
  const acqMin = Math.min(...acq);

  const add = (x: number) => {
    const r = Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
    if (!obs.some((o) => Math.abs(o - r) < 0.004)) setObs((o) => [...o, r]);
  };

  return (
    <div className="card">
      <div className="cs-controls">
        <label className="cs-field">
          <span>Length-scale ℓ: {ls.toFixed(2)}</span>
          <input type="range" min={0.03} max={0.4} step={0.01} value={ls} onChange={(e) => setLs(+e.target.value)} />
        </label>
        <label className="cs-field">
          <span>Noise variance: {noise.toFixed(3)}</span>
          <input
            type="range"
            min={0.0001}
            max={0.1}
            step={0.0001}
            value={noise}
            onChange={(e) => setNoise(+e.target.value)}
          />
        </label>
        <label className="row">
          <input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} /> Samples
          from the posterior
        </label>
        <label className="row">
          <input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} /> Reveal the
          hidden function
        </label>
      </div>
      <Plot
        aria="Gaussian process posterior: mean, a band of two standard deviations, samples and the observations. Click to add an observation."
        xDomain={[0, 1]}
        yDomain={[-1.6, 1.8]}
        xLabel="input x (click the plot to measure here)"
        bands={[
          {
            upper: XS.map((x, i) => [x, post[i].mean + 2 * post[i].sd]),
            lower: XS.map((x, i) => [x, post[i].mean - 2 * post[i].sd]),
            cls: 'pl-s1',
          },
        ]}
        series={[
          ...(showTruth ? [{ points: XS.map((x) => [x, g(x)] as [number, number]), cls: 'pl-s2', dashed: true }] : []),
          ...samples.map((s) => ({
            points: s.map((v, i) => [XS[i * 2], v] as [number, number]),
            cls: 'pl-s4',
            thin: true,
          })),
          { points: XS.map((x, i) => [x, post[i].mean] as [number, number]), cls: 'pl-s1' },
        ]}
        markers={obs.map((x, i) => ({ x, y: ys[i], cls: 'pl-bad', r: 5, label: `x = ${x}, y = ${ys[i].toFixed(3)}` }))}
        vlines={[{ at: next, cls: 'pl-good', label: 'suggested next' }]}
        onPick={(x) => add(x)}
      />
      <div className="pl-legend">
        <Key cls="pl-s1">posterior mean, ±2 standard deviations shaded</Key>
        {showSamples && <Key cls="pl-s4">three functions drawn from the posterior</Key>}
        {showTruth && (
          <Key cls="pl-s2" dashed>
            the hidden function
          </Key>
        )}
      </div>
      <div className="cs-controls" id="acq">
        <div className="chips" role="group" aria-label="Acquisition function">
          {(
            [
              ['ei', 'Expected improvement'],
              ['ucb', 'Upper confidence bound'],
              ['pi', 'Probability of improvement'],
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
            <input type="range" min={0} max={5} step={0.1} value={kappa} onChange={(e) => setKappa(+e.target.value)} />
          </label>
        )}
      </div>
      <Plot
        aria="The acquisition function across the input; its highest point is the suggested next measurement"
        xDomain={[0, 1]}
        yDomain={kind === 'ucb' ? [Math.min(acqMin, 0), acqMax] : [0, acqMax]}
        height={150}
        yTicks={[]}
        xLabel="where the acquisition function is highest, measure next"
        series={[{ points: XS.map((x, i) => [x, acq[i]] as [number, number]), cls: 'pl-good' }]}
        vlines={[{ at: next, cls: 'pl-good' }]}
      />
      <div className="row">
        <button type="button" className="btn primary" onClick={() => add(next)}>
          Measure at the suggestion (x = {next.toFixed(3)})
        </button>
        <button type="button" className="btn" onClick={() => setObs([0.15, 0.5, 0.9])}>
          Start again
        </button>
        <span className="small muted">
          {obs.length} measurements; best so far {best.toFixed(3)} (the true maximum is about{' '}
          {Math.max(...XS.map(g)).toFixed(3)})
        </span>
      </div>
    </div>
  );
}

/* ---------- Bayesian optimisation against random search in 2D ---------- */

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const BUDGET = 25;

function BayesTwoD() {
  const [seed, setSeed] = useState(2);
  const [step, setStep] = useState(BUDGET);
  const curves = useMemo(() => {
    const bo = SEEDS.map((s) => bayesSearch(BUDGET, s));
    const rnd = SEEDS.map((s) => randomSearch(BUDGET, s));
    return { bo, rnd, boMean: meanCurve(bo), rndMean: meanCurve(rnd) };
  }, []);
  const bo = curves.bo[seed - 1];
  const rnd = curves.rnd[seed - 1];
  const found = curves.bo.filter((t) => t.bestSoFar[BUDGET - 1] > 1).length;
  const its = Array.from({ length: BUDGET }, (_, i) => i + 1);
  return (
    <div className="card">
      <div className="cs-controls">
        <label className="cs-field">
          <span>Run (seed): {seed}</span>
          <input type="range" min={1} max={SEEDS.length} value={seed} onChange={(e) => setSeed(+e.target.value)} />
        </label>
        <label className="cs-field">
          <span>
            After {step} of {BUDGET} evaluations
          </span>
          <input type="range" min={1} max={BUDGET} value={step} onChange={(e) => setStep(+e.target.value)} />
        </label>
      </div>
      <div className="grid2">
        <div>
          <h3 className="tu-flush">Bayesian optimisation: best {bo.bestSoFar[step - 1].toFixed(3)}</h3>
          <Heat
            f={hidden2d}
            points={bo.points.slice(0, step).map((p, i) => ({
              p,
              cls: i < 4 ? 'tu-init' : 'tu-bo',
              ring: i === step - 1,
              label: `evaluation ${i + 1}: ${bo.values[i].toFixed(3)}`,
            }))}
            aria="The hidden function with the points Bayesian optimisation chose"
          />
        </div>
        <div>
          <h3 className="tu-flush">Random search: best {rnd.bestSoFar[step - 1].toFixed(3)}</h3>
          <Heat
            f={hidden2d}
            points={rnd.points.slice(0, step).map((p, i) => ({
              p,
              cls: 'tu-rand',
              ring: i === step - 1,
              label: `evaluation ${i + 1}: ${rnd.values[i].toFixed(3)}`,
            }))}
            aria="The hidden function with random search's points"
          />
        </div>
      </div>
      <p className="small muted">
        Darker is better. Grey dots are the four random starting points; the ring is the latest evaluation.
      </p>
      <Plot
        aria="Best value found against evaluations, averaged over eight runs, for Bayesian optimisation and random search"
        xDomain={[1, BUDGET]}
        yDomain={[0.4, 1.05]}
        xLabel="evaluations"
        yLabel="best so far"
        series={[
          ...curves.bo.map((t) => ({
            points: its.map((i) => [i, t.bestSoFar[i - 1]] as [number, number]),
            cls: 'pl-s1',
            thin: true,
          })),
          { points: its.map((i) => [i, curves.boMean[i - 1]] as [number, number]), cls: 'pl-s1' },
          { points: its.map((i) => [i, curves.rndMean[i - 1]] as [number, number]), cls: 'pl-s2' },
        ]}
        hlines={[{ at: hidden2d([0.78, 0.27]), cls: 'pl-good', label: 'maximum' }]}
        vlines={[{ at: step, cls: 'pl-muted' }]}
      />
      <div className="pl-legend">
        <Key cls="pl-s1">Bayesian optimisation (each run thin, mean thick)</Key>
        <Key cls="pl-s2">random search, mean of eight runs</Key>
      </div>
      <p>
        Every Bayesian run climbs the broad hill within a handful of evaluations, far faster than random search. Only{' '}
        <b>
          {found} of {SEEDS.length}
        </b>{' '}
        runs find the narrow, taller peak in {BUDGET} evaluations: once the broad hill is known, expected improvement
        keeps refining it, and a peak this narrow is easy to miss between samples. That is the honest picture of
        Bayesian optimisation: efficient, not magic. More starting points, a shorter length-scale or a more exploring
        acquisition change the odds, at the cost of evaluations.
      </p>
    </div>
  );
}

/* ---------- Code ---------- */

const SKLEARN = `from scipy.stats import loguniform, randint
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GridSearchCV, RandomizedSearchCV, StratifiedKFold

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
model = HistGradientBoostingClassifier(early_stopping=True, random_state=0)

# A grid: every combination, 3 x 3 = 9 settings, each scored by 5-fold cross-validation.
grid = GridSearchCV(model, {"learning_rate": [0.01, 0.1, 0.3], "max_depth": [3, 6, None]},
                    scoring="roc_auc", cv=cv, n_jobs=-1)

# Random search: the same 9 trials, but every trial tries a new value of every hyperparameter.
rand = RandomizedSearchCV(model, {"learning_rate": loguniform(1e-3, 0.5),   # log scale
                                  "max_leaf_nodes": randint(8, 128),
                                  "l2_regularization": loguniform(1e-4, 10)},
                          n_iter=9, scoring="roc_auc", cv=cv, random_state=0, n_jobs=-1)
rand.fit(X_train, y_train)
print(rand.best_params_, rand.best_score_)   # the cross-validated score, not the test score
`;

const OPTUNA = `import optuna
from sklearn.model_selection import cross_val_score

def objective(trial):
    params = {
        "learning_rate": trial.suggest_float("learning_rate", 1e-3, 0.5, log=True),
        "max_leaf_nodes": trial.suggest_int("max_leaf_nodes", 8, 128, log=True),
        "l2_regularization": trial.suggest_float("l2_regularization", 1e-4, 10, log=True),
    }
    model = HistGradientBoostingClassifier(**params, random_state=0)
    return cross_val_score(model, X_train, y_train, cv=cv, scoring="roc_auc").mean()

# TPE is Optuna's default model-based sampler; the pruner stops poor trials early (successive halving).
study = optuna.create_study(direction="maximize",
                            sampler=optuna.samplers.TPESampler(seed=0),
                            pruner=optuna.pruners.SuccessiveHalvingPruner())
study.optimize(objective, n_trials=60)
print(study.best_params)

# Only now, once, on data the search never saw:
final = HistGradientBoostingClassifier(**study.best_params, random_state=0).fit(X_train, y_train)
print("test AUC", roc_auc_score(y_test, final.predict_proba(X_test)[:, 1]))
`;

export default function TuningPage() {
  return (
    <main className="page-tuning">
      <p className="kicker">Course · weeks 14 and 18</p>
      <h1>Hyperparameter tuning and Bayesian optimisation</h1>
      <p className="lede">
        A model learns its parameters from data. You choose its hyperparameters, and the choice can matter as much as
        the model. This page compares the ways to search for them on invented validation losses, then builds Bayesian
        optimisation from a Gaussian process you can poke at. Everything runs in your browser.
      </p>
      <SectionNav sections={SECTIONS} />

      <CourseSection id="what" title="Parameters and hyperparameters" weeks={[18]}>
        <p>
          <b>Parameters</b> are learned by training: the weights of a network, the split points of a tree, the
          coefficients of a regression. <b>Hyperparameters</b> are set before training and shape how it goes: the
          learning rate, the depth of a tree, the strength of regularisation, the number of neighbours.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Model</th>
                <th>Learned parameters</th>
                <th>Hyperparameters you tune</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Logistic regression</td>
                <td>One weight per feature, an intercept</td>
                <td>Regularisation strength C, L1 or L2</td>
              </tr>
              <tr>
                <td>Gradient-boosted trees</td>
                <td>The trees and their leaf values</td>
                <td>Learning rate, number of trees, depth or leaves, subsampling</td>
              </tr>
              <tr>
                <td>k-nearest neighbours</td>
                <td>None: it stores the data</td>
                <td>k, the distance measure, weighting by distance</td>
              </tr>
              <tr>
                <td>Neural network</td>
                <td>Weights and biases</td>
                <td>Learning rate and schedule, batch size, width, depth, dropout, weight decay</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Every tuning method has the same loop: choose settings, train, score on data the training did not see, repeat.
          They differ only in how they choose the next settings and when they stop a bad trial early.
        </p>
      </CourseSection>

      <CourseSection id="grid" title="Grid search or random search" weeks={[18]}>
        <p>
          A grid tries every combination of a few values. It feels thorough, but when one hyperparameter matters far
          more than the other, most of the grid&apos;s trials repeat the same few values of the one that matters. Random
          search spends the same number of trials and tries a new value of every hyperparameter each time.
        </p>
        <GridVersusRandom />
      </CourseSection>

      <CourseSection id="halving" title="Stop bad trials early: successive halving" weeks={[18]}>
        <p>
          Most trials are clearly poor long before training ends. Successive halving trains every configuration for a
          little, keeps the best 1/η, trains the survivors η times longer, and repeats. Hyperband runs several of these
          with different starting budgets, because a slow starter can be dropped too soon. The invented configurations
          below each have a final loss and a speed of learning.
        </p>
        <Halving />
      </CourseSection>

      <CourseSection id="gp" title="A Gaussian process: a model of the thing you are tuning" weeks={[14]}>
        <p>
          Bayesian optimisation builds a cheap model, the <b>surrogate</b>, of the expensive function (here, any hidden
          function of one input; in practice, the validation score as a function of a hyperparameter). A Gaussian
          process is the usual surrogate. It gives a mean and a spread at every input, passes close to every
          measurement, and is unsure far from them.
        </p>
        <p>
          Click the plot to measure the hidden function at that input. The <b>length-scale</b> says how far apart two
          inputs can be and still move together; the <b>noise</b> says how much a repeated measurement could differ, so
          the mean need not pass through every point.
        </p>
        <GaussianProcess />
      </CourseSection>

      <CourseSection id="acq" title="Acquisition functions: where to measure next" weeks={[14]}>
        <p>
          The surrogate says what we know; an <b>acquisition function</b> turns that into a decision. Each balances
          exploitation (measure where the mean is high) against exploration (measure where the spread is wide). With
          best value so far <i>f*</i>, mean μ and spread σ at a point:
        </p>
        <ul>
          <li>
            <b>Probability of improvement</b>: how likely the point beats <i>f*</i>. Greedy: it prefers a sure, tiny
            gain.
          </li>
          <li>
            <b>Expected improvement</b>: the average amount by which it beats <i>f*</i>, counting both how likely and
            how large. The usual default.
          </li>
          <li>
            <b>Upper confidence bound</b>: μ + κσ. κ sets the balance directly: 0 is pure exploitation, large κ is
            exploration.
          </li>
        </ul>
        <p>
          Switch between them above and watch where the suggestion moves. With few measurements all three explore; once
          a good region is found, expected and probable improvement settle on it, and UCB with a large κ keeps looking
          elsewhere.
        </p>
      </CourseSection>

      <CourseSection id="bo" title="Bayesian optimisation against random search in two dimensions" weeks={[14]}>
        <p>
          The same loop on a hidden function of two inputs, with a broad hill and a taller, narrow peak. Four random
          starting points, then each next point is where expected improvement is highest. Random search gets the same
          number of evaluations.
        </p>
        <BayesTwoD />
      </CourseSection>

      <CourseSection id="practice" title="Tuning in practice" weeks={[18]}>
        <ul>
          <li>
            <b>Search on a log scale</b> for anything that spans orders of magnitude (learning rate, regularisation, C).
            Sampling uniformly between 0.0001 and 1 puts nine trials in ten above 0.1.
          </li>
          <li>
            <b>Fix a budget first</b>: a number of trials or hours. Start with random search to learn which
            hyperparameters matter, then narrow the ranges or switch to a model-based search.
          </li>
          <li>
            <b>Stop early</b>: early stopping inside each training run, and pruning (successive halving) across runs.
          </li>
          <li>
            <b>Score with cross-validation</b> when data is small, so one lucky split does not choose the settings.
          </li>
          <li>
            <b>Do not overfit the validation set.</b> The more trials, the more the best score is luck. Report the
            chosen settings on a test set the search never touched, or use nested cross-validation (see{' '}
            <Link to="/model-evaluation#nested">model evaluation</Link>).
          </li>
          <li>
            <b>Record every trial</b> with its settings and seed, as a tracking server does (see{' '}
            <Link to="/mlops#tracking">MLOps</Link>), so the result can be rebuilt and explained.
          </li>
          <li>
            <b>Fix the defaults first.</b> A sensible library default, good features and clean data usually beat a long
            search on a poor setup.
          </li>
        </ul>
      </CourseSection>

      <CourseSection id="code" title="The same ideas in scikit-learn and Optuna" weeks={[14, 18]}>
        <CodeBlock html={highlight(SKLEARN)} />
        <CodeBlock html={highlight(OPTUNA)} />
        <p className="small muted">
          Optuna&apos;s default sampler (TPE) is a model-based search like the Gaussian process here; scikit-optimize
          and BoTorch offer Gaussian-process Bayesian optimisation directly.
        </p>
      </CourseSection>

      <CourseSection id="quiz" title="Check yourself" weeks={[14, 18]}>
        <Quiz questions={QUIZ} />
      </CourseSection>

      <WhereUsed
        links={[
          ['/capstone', 'Capstone', 'optimise invented black boxes with these Gaussian-process helpers'],
          ['/model-evaluation', 'Model evaluation', 'cross-validation and nested CV, which tuning scores rely on'],
          ['/ml', 'Machine learning algorithms', 'the models whose hyperparameters you would tune'],
          ['/lora', 'Fine-tuning with LoRA', 'learning rate, rank and steps chosen for a real fine-tune'],
          ['/mlops', 'MLOps', 'tracking every trial and promoting the chosen model'],
        ]}
      />
    </main>
  );
}
