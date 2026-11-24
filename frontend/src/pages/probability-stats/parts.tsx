import { useMemo, useState } from 'react';
import {
  CLAIM_DAYS,
  KIOSK,
  LOAF_GRAMS,
  MEMBERS,
  STOP_MINUTES,
  THREE_DICE_OVER_12,
  VOCAB,
  binomialPmf,
  bootstrapMedian,
  coinLogLik,
  compareImputation,
  entropy,
  gini,
  linearFit,
  mean,
  monteCarloPi,
  normalLogLik,
  normalMle,
  normalPdf,
  piErrorCurve,
  poissonPmf,
  scoreSplit,
  screening,
  sse,
  summarise,
  survey,
  threeDiceOver12,
  naiveBayes,
  type Feature,
  type Mechanism,
  type Word,
} from './probstats';

/* The probability and statistics page's interactive parts. Every number shown comes from probstats.ts. */

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  show,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  show?: string;
}) {
  return (
    <label className="ps-slider">
      <span>
        {label} <b className="mono">{show ?? value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
    </label>
  );
}

/** Vertical bars for a discrete distribution or a histogram. */
function Bars({
  values,
  labels,
  highlight,
  height = 160,
}: {
  values: number[];
  labels?: string[];
  highlight?: (i: number) => boolean;
  height?: number;
}) {
  const w = 360;
  const max = Math.max(...values, 1e-9);
  const bw = w / values.length;
  return (
    <svg viewBox={`0 0 ${w} ${height + 18}`} className="ps-chart" role="img" aria-label="Bar chart">
      {values.map((v, i) => {
        const h = (v / max) * height;
        return (
          <g key={i}>
            <rect
              x={i * bw + 1}
              y={height - h}
              width={Math.max(1, bw - 2)}
              height={h}
              className={highlight?.(i) ? 'ps-bar on' : 'ps-bar'}
            />
            {labels && (values.length <= 21 || i % 5 === 0) && (
              <text x={i * bw + bw / 2} y={height + 14} textAnchor="middle" className="ps-tick">
                {labels[i]}
              </text>
            )}
          </g>
        );
      })}
      <line x1={0} y1={height} x2={w} y2={height} className="ps-axis" />
    </svg>
  );
}

/* ---------- Week 4: Bayes' rule ---------- */

/** A screening test for an invented condition, as 1,000 people: who has it, who tests positive. */
export function ScreeningTest() {
  const [prev, setPrev] = useState(1);
  const [sens, setSens] = useState(90);
  const [spec, setSpec] = useState(95);
  const s = screening(prev / 100, sens / 100, spec / 100);
  // Round each group to whole people for the picture, keeping the total at 1,000.
  const tp = Math.round(s.tp),
    fn = Math.round(s.fn),
    fp = Math.round(s.fp);
  const tn = 1000 - tp - fn - fp;
  const cells = [
    ...Array(tp).fill('tp'),
    ...Array(fn).fill('fn'),
    ...Array(fp).fill('fp'),
    ...Array(Math.max(0, tn)).fill('tn'),
  ] as string[];
  return (
    <div className="grid2 ps-pair">
      <div>
        <svg
          viewBox="0 0 400 250"
          className="ps-chart"
          role="img"
          aria-label="One thousand people coloured by condition and test result"
        >
          {cells.map((c, i) => (
            <rect
              key={i}
              x={(i % 40) * 10 + 1}
              y={Math.floor(i / 40) * 10 + 1}
              width={8}
              height={8}
              rx={2}
              className={`ps-${c}`}
            />
          ))}
        </svg>
        <p className="small ps-legend">
          <span className="ps-key ps-tp" /> has it, tests positive ({tp}) <span className="ps-key ps-fn" /> has it,
          missed ({fn}) <span className="ps-key ps-fp" /> false alarm ({fp}) <span className="ps-key ps-tn" /> clear (
          {tn})
        </p>
      </div>
      <div>
        <Slider
          label="How common it is"
          value={prev}
          min={0.1}
          max={20}
          step={0.1}
          onChange={setPrev}
          show={`${prev}%`}
        />
        <Slider
          label="Sensitivity: positive if you have it"
          value={sens}
          min={50}
          max={99.9}
          step={0.1}
          onChange={setSens}
          show={`${sens}%`}
        />
        <Slider
          label="Specificity: negative if you do not"
          value={spec}
          min={50}
          max={99.9}
          step={0.1}
          onChange={setSpec}
          show={`${spec}%`}
        />
        <div className="stats">
          <div className="stat">
            <div className="v">{pct(s.ppv)}</div>
            <div className="k">P(has it | positive)</div>
          </div>
          <div className="stat">
            <div className="v">{pct(s.npv, 2)}</div>
            <div className="k">P(clear | negative)</div>
          </div>
        </div>
        <p className="small">
          Bayes&apos; rule: P(has it | positive) = P(positive | has it) × P(has it) ÷ P(positive). In people: of the{' '}
          {tp + fp} positives, only {tp} have the condition. When it is rare, false alarms from the large healthy group
          outnumber the true cases, however good the test looks.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 4: distributions ---------- */

type Dist = 'bernoulli' | 'binomial' | 'poisson' | 'normal' | 'uniform';

const DISTS: { id: Dist; name: string; story: string }[] = [
  { id: 'bernoulli', name: 'Bernoulli', story: 'One yes-or-no trial: a single click, a single default.' },
  { id: 'binomial', name: 'Binomial', story: 'How many yeses in n independent trials with the same chance.' },
  {
    id: 'poisson',
    name: 'Poisson',
    story: 'How many events in a fixed window when they arrive independently at rate λ.',
  },
  { id: 'normal', name: 'Normal', story: 'The sum of many small independent effects: measurement error, heights.' },
  { id: 'uniform', name: 'Uniform', story: 'Every value in a range equally likely: a random number generator.' },
];

/** Pick a distribution, drag its parameters, and read its mean and variance. */
export function Distributions() {
  const [d, setD] = useState<Dist>('binomial');
  const [p, setP] = useState(0.3);
  const [n, setN] = useState(20);
  const [lambda, setLambda] = useState(4);
  const [mu, setMu] = useState(0);
  const [sigma, setSigma] = useState(1);
  const [lo, setLo] = useState(-1);
  const [hi, setHi] = useState(2);
  const info = DISTS.find((x) => x.id === d)!;

  let chart;
  let m: number, v: number;
  if (d === 'bernoulli') {
    chart = <Bars values={[1 - p, p]} labels={['0', '1']} />;
    [m, v] = [p, p * (1 - p)];
  } else if (d === 'binomial') {
    const ks = Array.from({ length: n + 1 }, (_, k) => k);
    chart = <Bars values={ks.map((k) => binomialPmf(n, p, k))} labels={ks.map(String)} />;
    [m, v] = [n * p, n * p * (1 - p)];
  } else if (d === 'poisson') {
    const ks = Array.from({ length: 26 }, (_, k) => k);
    chart = <Bars values={ks.map((k) => poissonPmf(lambda, k))} labels={ks.map(String)} />;
    [m, v] = [lambda, lambda];
  } else {
    const xs = Array.from({ length: 121 }, (_, i) => -6 + i * 0.1);
    const ys =
      d === 'normal' ? xs.map((x) => normalPdf(x, mu, sigma)) : xs.map((x) => (x >= lo && x <= hi ? 1 / (hi - lo) : 0));
    const top = Math.max(...ys, 0.01);
    chart = (
      <svg viewBox="0 0 360 178" className="ps-chart" role="img" aria-label="Density curve">
        <polyline
          points={xs.map((x, i) => `${((x + 6) / 12) * 360},${160 - (ys[i] / top) * 150}`).join(' ')}
          className="ps-curve"
        />
        <line x1={0} y1={160} x2={360} y2={160} className="ps-axis" />
        {[-6, -3, 0, 3, 6].map((t) => (
          <text key={t} x={((t + 6) / 12) * 360} y={174} textAnchor="middle" className="ps-tick">
            {t}
          </text>
        ))}
      </svg>
    );
    [m, v] = d === 'normal' ? [mu, sigma * sigma] : [(lo + hi) / 2, (hi - lo) ** 2 / 12];
  }

  return (
    <div className="grid2 ps-pair">
      <div>{chart}</div>
      <div>
        <div className="chips">
          {DISTS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`chip-btn ${x.id === d ? 'on' : ''}`}
              onClick={() => setD(x.id)}
            >
              {x.name}
            </button>
          ))}
        </div>
        <p className="small muted">{info.story}</p>
        {(d === 'bernoulli' || d === 'binomial') && (
          <Slider label="p" value={p} min={0.01} max={0.99} step={0.01} onChange={setP} />
        )}
        {d === 'binomial' && <Slider label="n" value={n} min={1} max={40} step={1} onChange={setN} />}
        {d === 'poisson' && <Slider label="λ" value={lambda} min={0.2} max={15} step={0.1} onChange={setLambda} />}
        {d === 'normal' && (
          <>
            <Slider label="μ" value={mu} min={-3} max={3} step={0.1} onChange={setMu} />
            <Slider label="σ" value={sigma} min={0.3} max={3} step={0.1} onChange={setSigma} />
          </>
        )}
        {d === 'uniform' && (
          <>
            <Slider label="from" value={lo} min={-5} max={hi - 0.5} step={0.5} onChange={setLo} />
            <Slider label="to" value={hi} min={lo + 0.5} max={5} step={0.5} onChange={setHi} />
          </>
        )}
        <p>
          Mean <b className="mono">{m.toFixed(2)}</b>, variance <b className="mono">{v.toFixed(2)}</b>
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 4: Monte Carlo ---------- */

const ERROR_CURVE = piErrorCurve([10, 30, 100, 300, 1000, 3000, 10000, 30000], 12);

/** Throw darts to estimate π, and simulate dice for a probability with a known exact answer. */
export function MonteCarlo() {
  const [logN, setLogN] = useState(3);
  const n = Math.round(10 ** logN);
  const pi = useMemo(() => monteCarloPi(n), [n]);
  const dice = useMemo(() => threeDiceOver12(n), [n]);
  const lx = (x: number) => ((Math.log10(x) - 1) / 3.6) * 340 + 10;
  const ly = (e: number) => 150 - ((Math.log10(e) + 3.5) / 3) * 140;
  return (
    <div className="grid2 ps-pair">
      <svg viewBox="0 0 240 240" className="ps-chart ps-square" role="img" aria-label="Random darts in a square">
        <rect x={0} y={0} width={240} height={240} className="ps-frame" />
        <path d="M0 240 A240 240 0 0 1 240 0" className="ps-arc" />
        {pi.points.map(([x, y, hit], i) => (
          <circle key={i} cx={x * 240} cy={240 - y * 240} r={1.4} className={hit ? 'ps-hit' : 'ps-miss'} />
        ))}
      </svg>
      <div>
        <Slider
          label="Samples"
          value={logN}
          min={1}
          max={5}
          step={0.1}
          onChange={setLogN}
          show={n.toLocaleString('en-GB')}
        />
        <table className="t ps-tight">
          <tbody>
            <tr>
              <td>π from darts (4 × share inside)</td>
              <td className="num mono">{pi.estimate.toFixed(4)}</td>
              <td className="small muted">true 3.1416</td>
            </tr>
            <tr>
              <td>P(three dice total over 12)</td>
              <td className="num mono">{dice.toFixed(4)}</td>
              <td className="small muted">exact {THREE_DICE_OVER_12.toFixed(4)}</td>
            </tr>
          </tbody>
        </table>
        <svg
          viewBox="0 0 360 170"
          className="ps-chart"
          role="img"
          aria-label="Average error against number of samples, both on log scales"
        >
          <polyline points={ERROR_CURVE.map((e) => `${lx(e.n)},${ly(e.error)}`).join(' ')} className="ps-curve" />
          {ERROR_CURVE.map((e) => (
            <circle key={e.n} cx={lx(e.n)} cy={ly(e.error)} r={3} className="ps-hit" />
          ))}
          <text x={10} y={166} className="ps-tick">
            10 samples
          </text>
          <text x={350} y={166} textAnchor="end" className="ps-tick">
            30,000
          </text>
        </svg>
        <p className="small">
          Average error over 12 runs, on log scales. Each tenfold increase in samples cuts the error by about √10 ≈ 3:
          Monte Carlo error shrinks like 1/√n, whatever the problem.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 5: summaries and outliers ---------- */

/** Fifteen van stops plus one you control: how the mean, SD, median and IQR react to an outlier. */
export function Outliers() {
  const [extra, setExtra] = useState(40);
  const [on, setOn] = useState(true);
  const [z, setZ] = useState(2.5);
  const xs = on ? [...STOP_MINUTES, extra] : STOP_MINUTES;
  const s = summarise(xs, z);
  const X = (v: number) => 10 + (v / 60) * 340;
  return (
    <div className="grid2 ps-pair">
      <div>
        <svg viewBox="0 0 360 110" className="ps-chart" role="img" aria-label="Stop times as dots with a box plot">
          <rect x={X(s.q1)} y={20} width={X(s.q3) - X(s.q1)} height={26} className="ps-box" />
          <line x1={X(s.median)} y1={20} x2={X(s.median)} y2={46} className="ps-median" />
          <line x1={X(s.mean)} y1={14} x2={X(s.mean)} y2={52} className="ps-mean" />
          {xs.map((v, i) => (
            <circle
              key={i}
              cx={X(v)}
              cy={72 + (i % 4) * 7}
              r={4}
              className={s.iqrOutliers.includes(v) ? 'ps-out' : 'ps-hit'}
            />
          ))}
          {[0, 10, 20, 30, 40, 50, 60].map((t) => (
            <text key={t} x={X(t)} y={106} textAnchor="middle" className="ps-tick">
              {t}
            </text>
          ))}
        </svg>
        <p className="small ps-legend">
          <span className="ps-key ps-box-key" /> middle half (IQR) <span className="ps-key ps-median-key" /> median{' '}
          <span className="ps-key ps-mean-key" /> mean
        </p>
      </div>
      <div>
        <label>
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> add one more stop
        </label>
        <Slider label="Its minutes" value={extra} min={0} max={60} step={1} onChange={setExtra} />
        <div className="chips">
          {[2, 2.5, 3].map((k) => (
            <button key={k} type="button" className={`chip-btn ${k === z ? 'on' : ''}`} onClick={() => setZ(k)}>
              z limit {k}
            </button>
          ))}
        </div>
        <table className="t ps-tight">
          <tbody>
            <tr>
              <td>mean / median</td>
              <td className="num mono">
                {s.mean.toFixed(2)} / {s.median.toFixed(2)}
              </td>
            </tr>
            <tr>
              <td>standard deviation / IQR</td>
              <td className="num mono">
                {s.sd.toFixed(2)} / {s.iqr.toFixed(2)}
              </td>
            </tr>
            <tr>
              <td>outliers by the IQR rule</td>
              <td className="num mono">{s.iqrOutliers.join(', ') || 'none'}</td>
            </tr>
            <tr>
              <td>outliers by |z| &gt; {z}</td>
              <td className="num mono">{s.zOutliers.join(', ') || 'none'}</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          One long stop drags the mean and inflates the standard deviation; the median and IQR barely move. The z rule
          measures distance in standard deviations, which the outlier itself has inflated, so a moderate outlier can
          hide. The IQR rule is built from the middle half, so it cannot be pulled that way.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 5: likelihood ---------- */

/** Fit a coin's p and a normal's μ and σ by hand, watching the log-likelihood, then compare with the closed form. */
export function Likelihood() {
  const [heads, setHeads] = useState(14);
  const n = 20;
  const [p, setP] = useState(0.5);
  const [mu, setMu] = useState(796);
  const [sigma, setSigma] = useState(10);
  const best = normalMle(LOAF_GRAMS);
  const ps = Array.from({ length: 97 }, (_, i) => 0.02 + i * 0.01);
  const lls = ps.map((q) => coinLogLik(heads, n, q));
  const top = Math.max(...lls),
    bottom = Math.min(...lls);
  const Y = (ll: number) => 140 - ((ll - bottom) / (top - bottom || 1)) * 130;
  return (
    <div className="grid2 ps-pair">
      <div className="card">
        <h3 className="ps-flush">
          A coin: {heads} heads in {n} flips
        </h3>
        <Slider label="Heads seen" value={heads} min={0} max={n} step={1} onChange={setHeads} />
        <Slider label="Your guess at p" value={p} min={0.02} max={0.98} step={0.01} onChange={setP} />
        <svg viewBox="0 0 360 150" className="ps-chart" role="img" aria-label="Log-likelihood of p">
          <polyline points={ps.map((q, i) => `${q * 360},${Y(lls[i])}`).join(' ')} className="ps-curve" />
          <line x1={p * 360} y1={0} x2={p * 360} y2={145} className="ps-mean" />
          <line x1={(heads / n) * 360} y1={0} x2={(heads / n) * 360} y2={145} className="ps-median" />
        </svg>
        <p className="small">
          Log-likelihood at your p: <b className="mono">{coinLogLik(heads, n, p).toFixed(2)}</b>. The peak is at heads ÷
          flips = <b className="mono">{(heads / n).toFixed(2)}</b>: the maximum-likelihood estimate is the share you
          saw.
        </p>
      </div>
      <div className="card">
        <h3 className="ps-flush">Loaf weights: fit a normal</h3>
        <p className="small muted">Twelve invented loaves: {LOAF_GRAMS.join(', ')} g.</p>
        <Slider label="μ" value={mu} min={780} max={820} step={0.5} onChange={setMu} />
        <Slider label="σ" value={sigma} min={2} max={25} step={0.1} onChange={setSigma} />
        <p>
          Log-likelihood <b className="mono">{normalLogLik(LOAF_GRAMS, mu, sigma).toFixed(2)}</b>{' '}
          <span className="muted small">best possible {normalLogLik(LOAF_GRAMS, best.mu, best.sigma).toFixed(2)}</span>
        </p>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setMu(+best.mu.toFixed(1));
            setSigma(+best.sigma.toFixed(1));
          }}
        >
          Jump to the closed form
        </button>
        <p className="small">
          The best μ is the sample mean ({best.mu.toFixed(1)} g). The best σ ({best.sigma.toFixed(2)} g) divides by n,
          not n − 1, so it is slightly too small on average. That is a known bias of maximum likelihood on small
          samples.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 5: regression ---------- */

/** Place a line by hand on the kiosk data, then snap to least squares, and read the residuals. */
export function Regression() {
  const fit = linearFit(KIOSK.temp, KIOSK.drinks);
  const [slope, setSlope] = useState(-2);
  const [icept, setIcept] = useState(110);
  const X = (t: number) => 20 + (t / 24) * 320;
  const Y = (d: number) => 150 - ((d - 50) / 80) * 140;
  const mine = sse(KIOSK.temp, KIOSK.drinks, slope, icept);
  const best = sse(KIOSK.temp, KIOSK.drinks, fit.slope, fit.intercept);
  const resid = KIOSK.drinks.map((d, i) => d - (icept + slope * KIOSK.temp[i]));
  return (
    <div className="grid2 ps-pair">
      <div>
        <svg
          viewBox="0 0 360 160"
          className="ps-chart"
          role="img"
          aria-label="Hot drinks sold against temperature, with a line"
        >
          <line x1={X(0)} y1={Y(icept)} x2={X(24)} y2={Y(icept + slope * 24)} className="ps-mean" />
          {KIOSK.temp.map((t, i) => (
            <g key={i}>
              <line x1={X(t)} y1={Y(KIOSK.drinks[i])} x2={X(t)} y2={Y(icept + slope * t)} className="ps-resid" />
              <circle cx={X(t)} cy={Y(KIOSK.drinks[i])} r={3.5} className="ps-hit" />
            </g>
          ))}
        </svg>
        <svg viewBox="0 0 360 80" className="ps-chart" role="img" aria-label="Residuals against temperature">
          <line x1={0} y1={40} x2={360} y2={40} className="ps-axis" />
          {KIOSK.temp.map((t, i) => (
            <circle key={i} cx={X(t)} cy={40 - Math.max(-36, Math.min(36, resid[i] * 2))} r={3} className="ps-hit" />
          ))}
        </svg>
        <p className="small muted">
          Below: each residual (sold − predicted). A good line leaves them scattered around zero with no pattern.
        </p>
      </div>
      <div>
        <Slider label="Slope (drinks per °C)" value={slope} min={-6} max={2} step={0.05} onChange={setSlope} />
        <Slider label="Intercept (drinks at 0 °C)" value={icept} min={80} max={150} step={0.5} onChange={setIcept} />
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setSlope(+fit.slope.toFixed(2));
            setIcept(+fit.intercept.toFixed(1));
          }}
        >
          Snap to least squares
        </button>
        <table className="t ps-tight">
          <tbody>
            <tr>
              <td>your sum of squared errors</td>
              <td className="num mono">{mine.toFixed(0)}</td>
            </tr>
            <tr>
              <td>least squares</td>
              <td className="num mono">{best.toFixed(0)}</td>
            </tr>
            <tr>
              <td>best line</td>
              <td className="num mono">
                {fit.intercept.toFixed(1)} {fit.slope < 0 ? '−' : '+'} {Math.abs(fit.slope).toFixed(2)} × °C
              </td>
            </tr>
            <tr>
              <td>R²</td>
              <td className="num mono">{fit.r2.toFixed(3)}</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          Least squares picks the line with the smallest sum of squared residuals. If you assume the noise around the
          line is normal, the same line also has the highest likelihood. Either way you arrive at the same answer, and
          the noise level σ is estimated at {fit.sigma.toFixed(1)} drinks.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 5: the bootstrap ---------- */

/** Resample the claim times many times to get a confidence interval for the median, with no formula. */
export function Bootstrap() {
  const [b, setB] = useState(1000);
  const r = useMemo(() => bootstrapMedian(CLAIM_DAYS, b), [b]);
  const bins = Array.from({ length: 25 }, (_, i) => r.medians.filter((m) => m >= i && m < i + 1).length);
  return (
    <div className="grid2 ps-pair">
      <div>
        <Bars
          values={bins}
          labels={bins.map((_, i) => String(i))}
          highlight={(i) => i >= Math.floor(r.lo) && i <= r.hi}
        />
        <p className="small muted">
          Medians of {b.toLocaleString('en-GB')} resamples, in days. Shaded: the middle 95%.
        </p>
      </div>
      <div>
        <p className="small muted">Seventeen invented claims, in days: {CLAIM_DAYS.join(', ')}.</p>
        <Slider label="Resamples" value={b} min={100} max={5000} step={100} onChange={setB} />
        <table className="t ps-tight">
          <tbody>
            <tr>
              <td>median of the claims</td>
              <td className="num mono">{r.observed}</td>
            </tr>
            <tr>
              <td>95% bootstrap interval</td>
              <td className="num mono">
                {r.lo} to {r.hi}
              </td>
            </tr>
            <tr>
              <td>mean, for comparison</td>
              <td className="num mono">{mean(CLAIM_DAYS).toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          The bootstrap treats the sample as a stand-in for the population. Draw a new sample of the same size from it,
          with replacement, and recompute the statistic. Repeat a few thousand times; the spread of the answers shows
          how much the statistic would vary between samples. It works for medians, ratios and model scores, where there
          is no neat formula.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 3: missing data ---------- */

const MECH_TEXT: Record<Mechanism, string> = {
  MCAR: 'Missing completely at random: a third of forms were lost in the post, whoever filled them in. Dropping those rows costs precision but not accuracy.',
  MAR: 'Missing at random: younger people skipped the question more often. Age is in the data, so the gap can be explained, and a model that uses age repairs most of the bias.',
  MNAR: 'Missing not at random: higher earners declined to say. The reason is the missing value itself, so nothing in the data can fully repair it. Every method underestimates.',
};

/** One invented survey under three missingness mechanisms, and what three fixes do to the average income. */
export function MissingData() {
  const [mech, setMech] = useState<Mechanism>('MAR');
  const people = useMemo(() => survey(mech), [mech]);
  const c = compareImputation(people);
  const X = (a: number) => 10 + ((a - 22) / 44) * 340;
  const Y = (inc: number) => 150 - (inc / 80) * 140;
  const missing = people.filter((p) => p.missing).length;
  return (
    <div className="grid2 ps-pair">
      <div>
        <svg
          viewBox="0 0 360 160"
          className="ps-chart"
          role="img"
          aria-label="Income against age; hollow points are missing"
        >
          {people.map((p, i) => (
            <circle key={i} cx={X(p.age)} cy={Y(p.income)} r={2.4} className={p.missing ? 'ps-gone' : 'ps-hit'} />
          ))}
        </svg>
        <p className="small muted">
          Income against age for 400 invented people. Hollow: the {missing} whose income is missing (you would not see
          them; the page can, because it invented them).
        </p>
      </div>
      <div>
        <div className="chips">
          {(['MCAR', 'MAR', 'MNAR'] as const).map((m) => (
            <button key={m} type="button" className={`chip-btn ${m === mech ? 'on' : ''}`} onClick={() => setMech(m)}>
              {m}
            </button>
          ))}
        </div>
        <p className="small">{MECH_TEXT[mech]}</p>
        <div className="table-wrap">
          <table className="t ps-tight">
            <thead>
              <tr>
                <th>Method</th>
                <th className="num">Mean (£k)</th>
                <th className="num">Bias</th>
                <th className="num">SD</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>The truth</td>
                <td className="num mono">{c.trueMean.toFixed(1)}</td>
                <td className="num mono">—</td>
                <td className="num mono">{c.trueSd.toFixed(1)}</td>
              </tr>
              {c.rows.map((r) => (
                <tr key={r.method}>
                  <td>{r.method}</td>
                  <td className="num mono">{r.mean.toFixed(1)}</td>
                  <td className={`num mono ${Math.abs(r.bias) > 1 ? 'ps-bad' : ''}`}>
                    {r.bias > 0 ? '+' : ''}
                    {r.bias.toFixed(1)}
                  </td>
                  <td className="num mono">{r.sd.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          Filling with the mean never changes the mean, but it shrinks the spread, because every filled value sits in
          the middle. A model trained on that data will think incomes vary less than they do.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 10: entropy and Gini ---------- */

/** One node's class mix on a slider, then the three candidate first splits on the climbing-wall members. */
export function Impurity() {
  const [yes, setYes] = useState(9);
  const n = 16;
  const ps = Array.from({ length: 101 }, (_, i) => i / 100);
  const X = (p: number) => 10 + p * 340;
  const Y = (v: number) => 130 - v * 120;
  const splits = (['visits', 'plan', 'classes'] as Feature[]).map((f) => scoreSplit(MEMBERS, f));
  const best = splits.reduce((a, b) => (b.infoGain > a.infoGain ? b : a));
  return (
    <>
      <div className="grid2 ps-pair">
        <svg
          viewBox="0 0 360 145"
          className="ps-chart"
          role="img"
          aria-label="Entropy and Gini against the share in one class"
        >
          <polyline points={ps.map((p) => `${X(p)},${Y(entropy([p, 1 - p]))}`).join(' ')} className="ps-curve" />
          <polyline points={ps.map((p) => `${X(p)},${Y(gini([p, 1 - p]))}`).join(' ')} className="ps-curve2" />
          <line x1={X(yes / n)} y1={5} x2={X(yes / n)} y2={135} className="ps-mean" />
          <line x1={0} y1={130} x2={360} y2={130} className="ps-axis" />
        </svg>
        <div>
          <Slider label="Renewed, out of 16 at this node" value={yes} min={0} max={n} step={1} onChange={setYes} />
          <p>
            <span className="ps-key ps-curve-key" /> entropy{' '}
            <b className="mono">{entropy([yes, n - yes]).toFixed(3)}</b> bits <span className="ps-key ps-curve2-key" />{' '}
            Gini <b className="mono">{gini([yes, n - yes]).toFixed(3)}</b>
          </p>
          <p className="small">
            Both are zero for a pure node and largest for an even mix. Entropy is the average number of yes-or-no
            questions needed to name a member&apos;s class. Gini is the chance that two members picked at random
            disagree.
          </p>
        </div>
      </div>
      <h3>Choosing the first split</h3>
      <p className="small muted">
        Sixteen invented climbing-wall members: {MEMBERS.filter((m) => m.renewed).length} renewed,{' '}
        {MEMBERS.filter((m) => !m.renewed).length} did not. A tree tries each question and keeps the one that leaves the
        purest branches.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Split on</th>
              <th>Branches (renewed / left)</th>
              <th className="num">Information gain</th>
              <th className="num">Gini drop</th>
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => (
              <tr key={s.feature} className={s === best ? 'ps-best' : undefined}>
                <td>{s.feature}</td>
                <td className="mono small">
                  {s.branches.map((b) => `${b.value}: ${b.counts[0]}/${b.counts[1]}`).join('   ')}
                </td>
                <td className="num mono">{s.infoGain.toFixed(3)}</td>
                <td className="num mono">{s.giniDrop.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        Information gain is the parent&apos;s entropy minus the size-weighted entropy of the branches. Here both
        measures pick <b>{best.feature}</b>. They usually agree; Gini is a little cheaper to compute, which is why many
        libraries use it by default.
      </p>
    </>
  );
}

/* ---------- Week 12: naive Bayes ---------- */

/** Tick the words in a message and watch each one multiply the odds of spam. */
export function NaiveBayes() {
  const [present, setPresent] = useState<Word[]>(['free', 'click']);
  const r = naiveBayes(present);
  return (
    <div className="grid2 ps-pair">
      <div>
        <p className="small muted">
          Twelve invented training messages, five of them spam. Tick the words in a new message.
        </p>
        <div className="table-wrap">
          <table className="t ps-tight">
            <thead>
              <tr>
                <th>Word</th>
                <th className="num">P(word | spam)</th>
                <th className="num">P(word | not spam)</th>
                <th className="num">Odds × </th>
              </tr>
            </thead>
            <tbody>
              {VOCAB.map((w) => (
                <tr key={w}>
                  <td>
                    <label>
                      <input
                        type="checkbox"
                        checked={present.includes(w)}
                        onChange={(e) =>
                          setPresent(e.target.checked ? [...present, w] : present.filter((x) => x !== w))
                        }
                      />{' '}
                      {w}
                    </label>
                  </td>
                  <td className="num mono">{r.likelihood[w][0].toFixed(2)}</td>
                  <td className="num mono">{r.likelihood[w][1].toFixed(2)}</td>
                  <td className={`num mono ${present.includes(w) ? '' : 'muted'}`}>
                    {(r.likelihood[w][0] / r.likelihood[w][1]).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div className="stats">
          <div className="stat">
            <div className="v">{pct(r.prior, 0)}</div>
            <div className="k">spam before reading (the prior)</div>
          </div>
          <div className="stat">
            <div className="v">{pct(r.posterior)}</div>
            <div className="k">P(spam | these words)</div>
          </div>
        </div>
        <p className="small">
          Start from the prior odds of spam, then multiply by each ticked word&apos;s ratio. That is Bayes&apos; rule
          with one bold assumption: given the class, words appear independently. They do not, which is why the
          probabilities come out overconfident, but the ranking is often good enough. Each likelihood adds one to the
          count, so a word never seen in spam does not make spam impossible.
        </p>
        <p className="small muted">
          This simple version only counts words that are present. A full Bernoulli model would also count the absent
          ones.
        </p>
      </div>
    </div>
  );
}
