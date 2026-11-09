import { useState } from 'react';
import { normalCdf, wilson } from './stats';
import { pct, Readout, Slider } from './ui';

const SIZES = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const Z95 = 1.959964;
const Z80 = 0.841621;

/** Two models on the same benchmark: is the gap bigger than the noise? */
export default function Significance() {
  const [sizeIdx, setSizeIdx] = useState(4);
  const [a, setA] = useState(82);
  const [b, setB] = useState(80);
  const [agree, setAgree] = useState(85);
  const n = SIZES[sizeIdx];
  const pa = a / 100;
  const pb = b / 100;
  const diff = pa - pb;
  const [aLo, aHi] = wilson(pa, n);
  const [bLo, bHi] = wilson(pb, n);

  // Unpaired: treat the two scores as independent samples.
  const seUnpaired = Math.sqrt((pa * (1 - pa) + pb * (1 - pb)) / n);
  // Paired (same questions): only the questions they disagree on carry information (McNemar's test).
  const disagree = Math.max(1 - agree / 100, Math.abs(diff) + 1e-9); // at least the gap itself
  const sePaired = Math.sqrt(Math.max(disagree - diff * diff, 1e-12) / n);
  const zU = diff / seUnpaired;
  const zP = diff / sePaired;
  const pU = 2 * (1 - normalCdf(Math.abs(zU)));
  const pP = 2 * (1 - normalCdf(Math.abs(zP)));
  // Questions needed to detect this gap 80% of the time at the 5% level.
  const need = (variance: number) => (diff === 0 ? Infinity : Math.ceil(((Z95 + Z80) ** 2 * variance) / (diff * diff)));
  const needU = need(pa * (1 - pa) + pb * (1 - pb));
  const needP = need(Math.max(disagree - diff * diff, 1e-12));
  const fmtN = (v: number) => (Number.isFinite(v) ? v.toLocaleString('en-GB') : '—');

  return (
    <section className="bm-section">
      <h2>Is the difference real?</h2>
      <p>
        A benchmark is a sample of questions, so every score has noise. Two models two points apart on a few hundred questions
        may be equally good. The <a href="/evals">Evals lab</a> builds intervals for your own tests; here is the same idea for
        published benchmarks.
      </p>
      <div className="bm-controls">
        <Slider label="questions" value={sizeIdx} min={0} max={SIZES.length - 1} onChange={setSizeIdx} show={(i) => SIZES[i].toLocaleString('en-GB')} />
        <Slider label="model A score" value={a} min={1} max={99} onChange={setA} show={(v) => `${v}%`} />
        <Slider label="model B score" value={b} min={1} max={99} onChange={setB} show={(v) => `${v}%`} />
        <Slider label="questions they agree on" value={agree} min={50} max={99} onChange={setAgree} show={(v) => `${v}%`} />
      </div>
      <div className="bm-ci" aria-label="95% intervals for the two scores">
        {[
          ['A', pa, aLo, aHi, 'var(--s1)'],
          ['B', pb, bLo, bHi, 'var(--s2)'],
        ].map(([name, p, lo, hi, colour]) => (
          <div key={name as string} className="bm-ci-row">
            <span className="mono">{name as string}</span>
            <div className="bm-ci-track">
              <i style={{ left: `${(lo as number) * 100}%`, width: `${((hi as number) - (lo as number)) * 100}%`, background: colour as string }} />
              <b style={{ left: `${(p as number) * 100}%` }} />
            </div>
            <span className="small mono">
              {pct(p as number, 0)} ({pct(lo as number)}–{pct(hi as number)})
            </span>
          </div>
        ))}
      </div>
      <p className="bm-note">95% Wilson intervals for each score on {n.toLocaleString('en-GB')} questions.</p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Test of the {Math.abs(a - b)}-point gap</th>
              <th className="num">z</th>
              <th className="num">p-value</th>
              <th>Verdict</th>
              <th className="num">Questions needed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Unpaired: scores treated as independent</td>
              <td className="num">{zU.toFixed(2)}</td>
              <td className="num">{pU < 0.0001 ? '< 0.0001' : pU.toFixed(4)}</td>
              <td className={pU < 0.05 ? 'bm-good' : 'bm-bad'}>{pU < 0.05 ? 'real at 95%' : 'could be noise'}</td>
              <td className="num">{fmtN(needU)}</td>
            </tr>
            <tr>
              <td>Paired: same questions (McNemar), using the {100 - agree}% they disagree on</td>
              <td className="num">{zP.toFixed(2)}</td>
              <td className="num">{pP < 0.0001 ? '< 0.0001' : pP.toFixed(4)}</td>
              <td className={pP < 0.05 ? 'bm-good' : 'bm-bad'}>{pP < 0.05 ? 'real at 95%' : 'could be noise'}</td>
              <td className="num">{fmtN(needP)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Readout items={[['gap', `${(diff * 100).toFixed(0)} points`], ['unpaired standard error', `${(seUnpaired * 100).toFixed(2)} pts`], ['paired standard error', `${(sePaired * 100).toFixed(2)} pts`]]} />
      <p className="small">
        <b>Questions needed</b> is the size at which this gap would be detected 80% of the time at the 5% level. When both models
        were run on the same questions, compare them question by question: answers they share cancel out, so the paired test needs
        far fewer questions. Benchmarks with a few hundred questions or fewer, such as GPQA Diamond or a year of AIME, cannot separate
        models a couple of points apart on their own.
      </p>
    </section>
  );
}
