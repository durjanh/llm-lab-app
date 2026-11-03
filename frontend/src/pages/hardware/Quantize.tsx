import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { linspace } from '../deep-learning/kit';

/**
 * What quantisation does to a model, on a model small enough to see: 64 smooth bumps whose heights are the weights,
 * one of them an outlier (as real models have). The weights are rounded to a few bits, symmetrically, with one scale
 * shared by a group of weights, and the model's output is drawn again.
 */

const N = 64;
const XS = linspace(-Math.PI, Math.PI, 240);
const CENTRES = linspace(-Math.PI, Math.PI, N);
const OUTLIER = 40;
const target = (x: number) => Math.sin(2 * x) + 0.4 * Math.cos(5 * x);
const WEIGHTS = CENTRES.map((c, i) => (i === OUTLIER ? 4 : target(c)));
const WIDTH = (CENTRES[1] - CENTRES[0]) * 0.9;
// Each output is a weighted average of nearby bumps, so a weight's error shows up locally.
const BASIS = XS.map((x) => {
  const row = CENTRES.map((c) => Math.exp(-(((x - c) / WIDTH) ** 2) / 2));
  const total = row.reduce((s, v) => s + v, 0);
  return row.map((v) => v / total);
});
const run = (w: number[]) => BASIS.map((row) => row.reduce((s, b, i) => s + b * w[i], 0));
const FULL = run(WEIGHTS);

/** Symmetric quantisation: each group's largest weight sets the step size; every weight rounds to the nearest step. */
function quantise(w: number[], bits: number, group: number): number[] {
  const levels = 2 ** (bits - 1) - 1;
  const out = [...w];
  for (let start = 0; start < w.length; start += group) {
    const slice = w.slice(start, start + group);
    const scale = Math.max(...slice.map(Math.abs)) / levels || 1;
    slice.forEach((v, k) => (out[start + k] = Math.round(v / scale) * scale));
  }
  return out;
}

export default function Quantize() {
  const [bits, setBits] = useState(4);
  const [group, setGroup] = useState(64);
  const q = useMemo(() => quantise(WEIGHTS, bits, group), [bits, group]);
  const out = useMemo(() => run(q), [q]);
  const errors = FULL.map((v, i) => Math.abs(v - out[i]));
  const meanErr = errors.reduce((s, e) => s + e, 0) / errors.length;
  const maxErr = Math.max(...errors);
  const groups = Math.ceil(N / group);
  const bytes = Math.ceil((N * bits) / 8) + groups * 2; // weights, plus one 16-bit scale per group

  return (
    <section className="hw-section">
      <h2>NPUs and quantisation: smaller numbers, smaller models</h2>
      <p>
        Phones and laptops run models on their NPUs by storing each weight in fewer bits: 8 or 4 instead of 16 or 32. The model
        gets smaller and faster (less to read from memory, as above), and the NPU's integer maths uses little power. The cost is
        accuracy: each weight is rounded to one of a few steps, and the step size is set by the largest weight sharing a scale.
        This model's 64 weights are the heights of 64 bumps; one of them is an outlier, as real models have.
      </p>
      <div className="hw-controls">
        <label>
          Bits per weight
          <select value={bits} onChange={(e) => setBits(+e.target.value)}>
            {[8, 6, 4, 3, 2].map((b) => (
              <option key={b} value={b}>
                {b}-bit{b === 8 ? ' (INT8)' : b === 4 ? ' (INT4)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weights sharing one scale
          <select value={group} onChange={(e) => setGroup(+e.target.value)}>
            <option value={64}>all 64 (per tensor)</option>
            <option value={16}>groups of 16</option>
            <option value={8}>groups of 8</option>
          </select>
        </label>
      </div>
      <div className="hw-takeaways">
        <div className="card">
          <Plot
            x={[-Math.PI, Math.PI]}
            y={[-2, 4.5]}
            height={250}
            xLabel="input"
            yLabel="output"
            ariaLabel={`The model's output at full precision and at ${bits} bits`}
            draw={(f) => {
              f.line(XS, FULL, f.c.s1, 2.5);
              f.line(XS, out, f.c.s2, 2);
              f.dots(CENTRES.map((c, i) => [c, q[i]] as [number, number]), f.c.s2, 2);
              f.text('outlier weight', CENTRES[OUTLIER] + 0.15, 4.1, f.c.muted);
            }}
          />
          <div className="dl-legend small">
            <span>
              <i style={{ background: 'var(--s1)' }} /> full precision
            </span>{' '}
            <span>
              <i style={{ background: 'var(--s2)' }} /> {bits}-bit (dots: the rounded weights)
            </span>
          </div>
        </div>
        <div className="card">
          <table className="t">
            <tbody>
              <tr>
                <td>Size of the weights</td>
                <td className="num">
                  {N * 4} bytes at 32-bit → <b>{bytes} bytes</b>
                </td>
              </tr>
              <tr>
                <td>Smaller by</td>
                <td className="num">
                  <b>{((N * 4) / bytes).toFixed(1)}×</b>
                </td>
              </tr>
              <tr>
                <td>Average change in output</td>
                <td className="num">
                  <b>{meanErr.toFixed(3)}</b>
                </td>
              </tr>
              <tr>
                <td>Largest change in output</td>
                <td className="num">{maxErr.toFixed(3)}</td>
              </tr>
              <tr>
                <td>Steps each weight can take</td>
                <td className="num">{2 * (2 ** (bits - 1) - 1) + 1}</td>
              </tr>
            </tbody>
          </table>
          <p className="hw-note">Sizes include one 16-bit scale per group. The output mostly ranges from about −1.4 to 1.4.</p>
        </div>
      </div>
      <p className="small">
        <b>What to notice.</b> 8-bit is close to free: the curves overlap. 4-bit drifts and 2-bit loses the shape, because with
        one scale for all 64 weights, the outlier makes the steps coarse for every other weight. Switch to groups of 16 or 8:
        each group gets its own scale, so only the outlier's group pays, and the error roughly halves for a few extra bytes.
        That is what real methods do: GPTQ, AWQ and the formats NPUs use share a scale across small groups (often 32 to 128
        weights) and keep the most sensitive layers at higher precision.
      </p>
    </section>
  );
}
