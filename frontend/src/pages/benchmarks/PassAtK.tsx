import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { rng } from '../deep-learning/kit';
import { naivePassAtK, passAtK } from './stats';
import { pct, Readout, Slider } from './ui';

/** pass@k: the chance at least one of k attempts is right, estimated from n samples with c correct. */
export default function PassAtK() {
  const [n, setN] = useState(20);
  const [c, setC] = useState(5);
  const [k, setK] = useState(5);
  const cc = Math.min(c, n);
  const kk = Math.min(k, n);
  const unbiased = passAtK(n, cc, kk);
  const naive = naivePassAtK(n, cc, kk);

  // Is each estimator right on average? Draw n samples at a known success rate p = c/n, many times.
  const sim = useMemo(() => {
    const p = cc / n;
    const truth = 1 - (1 - p) ** kk;
    const r = rng(11);
    const trials = 4000;
    let u = 0;
    let v = 0;
    for (let t = 0; t < trials; t++) {
      let hits = 0;
      for (let i = 0; i < n; i++) if (r() < p) hits++;
      u += passAtK(n, hits, kk);
      v += naivePassAtK(n, hits, kk);
    }
    return { truth, unbiased: u / trials, naive: v / trials, trials };
  }, [n, cc, kk]);

  const ks = Array.from({ length: n }, (_, i) => i + 1);
  return (
    <section className="bm-section">
      <h2>pass@k: did any of k attempts work?</h2>
      <p>
        Coding benchmarks such as HumanEval report <b>pass@k</b>: the chance that at least one of <i>k</i> generated solutions
        passes the tests. Generate <i>n</i> samples per problem (n ≥ k), count the <i>c</i> that pass, and estimate it with{' '}
        <b>1 − C(n−c, k) / C(n, k)</b>: the chance that a random set of k of your n samples is not all failures (Chen et al.
        2021, the HumanEval paper). The obvious shortcut, <b>1 − (1 − c/n)<sup>k</sup></b>, is biased.
      </p>
      <div className="bm-controls">
        <Slider label="samples n" value={n} min={1} max={100} onChange={(v) => (setN(v), setC(Math.min(c, v)), setK(Math.min(k, v)))} />
        <Slider label="correct c" value={cc} min={0} max={n} onChange={setC} />
        <Slider label="k" value={kk} min={1} max={n} onChange={setK} />
      </div>
      <div className="bm-two">
        <div>
          <Readout items={[[`pass@${kk}, unbiased`, pct(unbiased)], [`pass@${kk}, naive`, pct(naive)], ['pass@1 (= c/n)', pct(cc / n)]]} />
          <p className="small">
            With n = {n}, c = {cc}, k = {kk}: 1 − C({n - cc}, {kk}) / C({n}, {kk}) = <b>{unbiased.toFixed(4)}</b>; the naive formula gives{' '}
            {naive.toFixed(4)}.
          </p>
          <div className="card bm-card">
            <b className="small">Which estimate is right on average?</b>
            <p className="small">
              Simulated {sim.trials.toLocaleString('en-GB')} times with a true per-sample success rate of {pct(cc / n)}: the true pass@{kk} is{' '}
              <b>{pct(sim.truth, 2)}</b>. The unbiased estimator averages <b>{pct(sim.unbiased, 2)}</b>; the naive one averages{' '}
              <b>{pct(sim.naive, 2)}</b>
              {Math.abs(sim.naive - sim.truth) > 0.002 ? `, ${sim.naive < sim.truth ? 'too low' : 'too high'} by ${((Math.abs(sim.naive - sim.truth)) * 100).toFixed(2)} points` : ''}.
              Plugging an estimate into a curved formula bends the average (Jensen's inequality).
            </p>
          </div>
        </div>
        <div>
          <Plot
            x={[1, Math.max(2, n)]}
            y={[0, 1]}
            height={230}
            xLabel="k"
            yLabel="pass@k"
            ariaLabel="pass@k against k, unbiased and naive"
            draw={(f) => {
              f.line(ks, ks.map((x) => naivePassAtK(n, cc, x)), f.c.s2, 2, [5, 4]);
              f.line(ks, ks.map((x) => passAtK(n, cc, x)), f.c.s1, 2.5);
              f.vline(kk, f.c.muted);
            }}
          />
          <div className="bm-legend small">
            <span><i style={{ background: 'var(--s1)' }} /> unbiased</span>
            <span><i style={{ background: 'var(--s2)' }} /> naive</span>
          </div>
        </div>
      </div>
      <p className="small muted">
        pass@k flatters a model that is right only sometimes: with c/n = 25%, pass@10 is far higher. Compare models at the same k,
        and for agents prefer pass@1, or pass^k (all k attempts succeed) when reliability matters.
      </p>
    </section>
  );
}
