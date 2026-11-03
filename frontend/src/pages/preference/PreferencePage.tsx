import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { linspace } from '../deep-learning/kit';
import {
  CANDIDATES,
  FEATURES,
  QUALITY,
  REFERENCE,
  candidatePairs,
  dpo,
  expectedQuality,
  fitRewardModel,
  labelPairs,
  labellerWeights,
  rlhf,
} from './toy';
import './preference.css';

const f2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** Lab 31: how a model is tuned towards the answers people prefer, and what can go wrong. */
export default function PreferencePage() {
  const [lengthBias, setLengthBias] = useState(1.6);
  const reward = useMemo(() => fitRewardModel(labelPairs(lengthBias)), [lengthBias]);
  const proxy = useMemo(() => CANDIDATES.map((c) => reward.w.reduce((s, w, i) => s + w * c.x[i], 0)), [reward]);

  return (
    <main className="page-preference">
      <div className="kicker">Lab 31 · Preference tuning</div>
      <h1>Preference tuning: RLHF, PPO and DPO</h1>
      <p className="lede">
        After supervised fine-tuning, a model can follow instructions. Preference tuning makes it give the answers people
        prefer: more helpful, more honest, better judged. It works from comparisons ("A is better than B") rather than
        written answers. This lab runs the whole thing on a toy problem small enough to see, including the way it goes wrong.
      </p>

      <Pipeline />
      <RewardModel lengthBias={lengthBias} setLengthBias={setLengthBias} reward={reward} proxy={proxy} />
      <PpoClip />
      <RewardHacking proxy={proxy} />
      <Dpo lengthBias={lengthBias} proxy={proxy} />
      <Compare />

      <section className="pt-section">
        <h2>Engineering takeaways</h2>
        <ul className="pt-takeaways">
          <li>
            <b>The model learns what raters reward, not what you meant.</b> A small bias in the comparisons (here, liking
            length) becomes part of the model. Check your preference data for it before training on it.
          </li>
          <li>
            <b>A reward model is a proxy, and optimising a proxy hard breaks it.</b> Push too far and the proxy keeps rising
            while real quality falls: reward hacking. Watch a separate, trusted measure of quality, not the reward.
          </li>
          <li>
            <b>The KL penalty (β) is the leash.</b> It keeps the tuned model close to the one you started from. Too loose and
            it hacks; too tight and it barely improves. DPO has the same β, and the same trade-off.
          </li>
          <li>
            <b>DPO is simpler and cheaper; it is not immune.</b> No reward model, no RL loop, but it learns the raters'
            biases just the same.
          </li>
        </ul>
      </section>
    </main>
  );
}

function Pipeline() {
  const steps = [
    { title: 'SFT model', body: 'Already follows instructions, from supervised fine-tuning on example answers.' },
    { title: 'Collect comparisons', body: 'Sample two answers to a prompt; a person (or a model) picks the better one.' },
    { title: 'Train a reward model', body: 'Learns a score so preferred answers score higher (Bradley–Terry).' },
    { title: 'Optimise the policy (PPO)', body: 'Generate answers, score them, and move towards higher scores, minus β × KL to the SFT model.' },
  ];
  return (
    <section className="pt-section">
      <h2>1. The RLHF pipeline</h2>
      <div className="pt-pipeline">
        {steps.map((s, i) => (
          <div key={s.title} className="pt-stage">
            <span className="pt-stage-num">{i + 1}</span>
            <b>{s.title}</b>
            <span className="small">{s.body}</span>
          </div>
        ))}
      </div>
      <p className="small">
        A frozen copy of the SFT model stays alongside as the <b>reference</b>. The KL penalty measures how far the tuned model's
        answers have drifted from it, and pays for drift out of the reward. <b>DPO</b> (section 5) collapses steps 3 and 4
        into one supervised loss on the comparisons themselves.
      </p>
    </section>
  );
}

function RewardModel({ lengthBias, setLengthBias, reward, proxy }: {
  lengthBias: number; setLengthBias: (v: number) => void; reward: ReturnType<typeof fitRewardModel>; proxy: number[];
}) {
  const hidden = labellerWeights(lengthBias);
  const maxW = Math.max(...reward.w, 1e-6);
  return (
    <section className="pt-section">
      <h2>2. A reward model from comparisons</h2>
      <p>
        Here each answer is described by three features: how correct, how helpful, and how long it is. 600 pairs of answers
        were judged by labellers whose taste is hidden from the model: they value correctness and helpfulness, and{' '}
        <b>they also like longer answers</b>, a common bias in real preference data. The reward model learns a score r(answer)
        so that P(A preferred over B) = σ(r(A) − r(B)), by gradient descent on 450 pairs, and is tested on the other 150.
      </p>
      <div className="row pt-controls">
        <label>
          Labellers' liking for length{' '}
          <input type="range" min={0} max={2.5} step={0.1} value={lengthBias} onChange={(e) => setLengthBias(+e.target.value)} />{' '}
          <span className="mono">{lengthBias.toFixed(1)}</span>
        </label>
      </div>
      <div className="pt-grid">
        <div className="card">
          <table className="t">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="num">Labellers' hidden weight</th>
                <th>Reward model learned</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f, i) => (
                <tr key={f}>
                  <td>{f}</td>
                  <td className="num">{hidden[i].toFixed(1)}</td>
                  <td>
                    <div className="pt-bar">
                      <i style={{ width: `${Math.max(0, (reward.w[i] / maxW) * 100)}%` }} className={i === 2 ? 'warn' : ''} />
                      <span className="mono">{f2(reward.w[i])}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">
            Accuracy on the 150 held-out pairs: <b>{pct(reward.accuracy)}</b>. The learned weights are about three times the
            labellers', because labellers are fairly consistent; what matters is their ratio.{' '}
            {reward.w[2] > 0.5 ? (
              <>The reward model has learned to like length.</>
            ) : (
              <>With little length bias, length barely counts.</>
            )}
          </p>
        </div>
        <div className="card">
          <Plot
            x={[0, reward.losses.length]}
            y={[0, 0.75]}
            height={180}
            xLabel="training step"
            yLabel="loss"
            ariaLabel="The reward model's training loss"
            draw={(f) => f.line(reward.losses.map((_, i) => i), reward.losses, f.c.brand, 2)}
          />
          <p className="small muted">Cross-entropy on the training pairs (log 2 ≈ 0.69 is guessing).</p>
        </div>
      </div>
      <h3>One prompt, eight candidate answers</h3>
      <p className="small">
        The policy in sections 4 and 5 chooses among these. <b>True quality</b> is what the answer is really worth (here,
        padding past a point costs), which neither the reward model nor training ever sees.
      </p>
      <div className="table-wrap">
        <table className="t pt-cands">
          <thead>
            <tr>
              <th>Answer</th>
              <th className="num">Correct</th>
              <th className="num">Helpful</th>
              <th className="num">Length</th>
              <th className="num">Reward model score</th>
              <th className="num">True quality</th>
              <th className="num">SFT model picks it</th>
            </tr>
          </thead>
          <tbody>
            {CANDIDATES.map((c, i) => (
              <tr key={c.name} className={proxy[i] === Math.max(...proxy) ? 'pt-top' : ''}>
                <td>{c.name}</td>
                {c.x.map((v, k) => (
                  <td key={k} className="num">
                    {v.toFixed(2)}
                  </td>
                ))}
                <td className="num">{f2(proxy[i])}</td>
                <td className="num">{f2(QUALITY[i])}</td>
                <td className="num">{pct(REFERENCE[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        Highlighted: the answer the reward model scores highest
        {proxy.indexOf(Math.max(...proxy)) !== QUALITY.indexOf(Math.max(...QUALITY))
          ? `. It is not the best answer; "${CANDIDATES[QUALITY.indexOf(Math.max(...QUALITY))].name}" is.`
          : ', which is also the best answer.'}
      </p>
    </section>
  );
}

function PpoClip() {
  const [eps, setEps] = useState(0.2);
  const rs = linspace(0, 2, 201);
  const clip = (r: number) => Math.min(Math.max(r, 1 - eps), 1 + eps);
  const obj = (r: number, a: number) => Math.min(r * a, clip(r) * a);
  return (
    <section className="pt-section">
      <h2>3. PPO: improve, but not too much at once</h2>
      <p>
        PPO updates the model from answers it generated a moment ago. The <b>ratio</b> r = π_new(answer) ÷ π_old(answer) says how
        much more (or less) likely the new model makes that answer; the <b>advantage</b> A says whether the answer did better
        (A &gt; 0) or worse (A &lt; 0) than expected. The objective is min(r·A, clip(r, 1−ε, 1+ε)·A).
      </p>
      <div className="row pt-controls">
        <label>
          ε (clip range){' '}
          <input type="range" min={0.05} max={0.5} step={0.05} value={eps} onChange={(e) => setEps(+e.target.value)} />{' '}
          <span className="mono">{eps.toFixed(2)}</span>
        </label>
      </div>
      <div className="pt-grid">
        {[1, -1].map((a) => (
          <div key={a} className="card">
            <b className="small">{a > 0 ? 'A better than expected (A = +1)' : 'A worse than expected (A = −1)'}</b>
            <Plot
              x={[0, 2]}
              y={[-2, 2]}
              height={200}
              xLabel="ratio r"
              yLabel="objective"
              ariaLabel={`PPO's clipped objective for advantage ${a}`}
              draw={(f) => {
                f.ctx.fillStyle = 'rgba(91, 79, 214, 0.08)';
                f.ctx.fillRect(f.x(1 - eps), f.y(2), f.x(1 + eps) - f.x(1 - eps), f.y(-2) - f.y(2));
                f.line(rs, rs.map((r) => r * a), f.c.muted, 1.5, [4, 4]);
                f.line(rs, rs.map((r) => obj(r, a)), f.c.brand, 3);
                f.vline(1, f.c.muted);
              }}
            />
          </div>
        ))}
      </div>
      <p className="small">
        Dashed: the unclipped r·A. Solid: what PPO maximises. When an answer was good, making it more likely helps only up to
        r = 1 + ε, after which the objective goes flat, so there is no reason to push further in one update. When it was
        bad, making it less likely helps only down to 1 − ε. Each step stays small, which keeps training stable: the model
        cannot leap to a policy its old samples say nothing about.
      </p>
    </section>
  );
}

function RewardHacking({ proxy }: { proxy: number[] }) {
  const [beta, setBeta] = useState(0);
  const run = useMemo(() => rlhf(proxy, beta), [proxy, beta]);
  const h = run.history;
  const steps = h.map((_, i) => i);
  const peak = h.reduce((b, s, i) => (s.quality > h[b].quality ? i : b), 0);
  const minQ = Math.min(...QUALITY, ...h.map((s) => s.quality)) - 0.2;
  const maxQ = Math.max(...h.map((s) => s.quality)) + 0.3;
  return (
    <section className="pt-section">
      <h2>4. Reward hacking, and the KL leash</h2>
      <p>
        Now tune the SFT model's choice among the eight answers to maximise the reward model's score, minus β × KL to the SFT
        model. (The gradient here is exact; PPO estimates the same thing from sampled answers, with clipping.) Watch the
        reward the model is trained on and the true quality nobody can see during training.
      </p>
      <div className="row pt-controls">
        <label>
          KL penalty β{' '}
          <input type="range" min={0} max={4} step={0.25} value={beta} onChange={(e) => setBeta(+e.target.value)} />{' '}
          <span className="mono">{beta.toFixed(2)}</span>
        </label>
        {[0, 2, 4].map((b) => (
          <button key={b} className={`chip-btn ${beta === b ? 'on' : ''}`} onClick={() => setBeta(b)}>
            β = {b}
            {b === 0 ? ' (no leash)' : ''}
          </button>
        ))}
      </div>
      <div className="pt-grid3">
        <div className="card">
          <b className="small">Reward model score (what training sees)</b>
          <Plot x={[0, steps.length - 1]} y={[Math.min(...h.map((s) => s.proxy)) - 0.3, Math.max(...proxy) + 0.3]} height={170} xLabel="step"
            ariaLabel="Average reward model score during training" draw={(f) => f.line(steps, h.map((s) => s.proxy), f.c.brand, 2.5)} />
        </div>
        <div className="card">
          <b className="small">True quality (hidden)</b>
          <Plot x={[0, steps.length - 1]} y={[minQ, maxQ]} height={170} xLabel="step" ariaLabel="Average true quality during training"
            draw={(f) => {
              f.hline(h[0].quality, f.c.muted);
              f.line(steps, h.map((s) => s.quality), f.c.s3, 2.5);
            }} />
        </div>
        <div className="card">
          <b className="small">KL from the SFT model</b>
          <Plot x={[0, steps.length - 1]} y={[0, 3.2]} height={170} xLabel="step" ariaLabel="KL divergence from the SFT model during training"
            draw={(f) => f.line(steps, h.map((s) => s.kl), f.c.s2, 2.5)} />
        </div>
      </div>
      <div className="pt-readout">
        <span>
          Reward score <b>{f2(h[0].proxy)} → {f2(h[h.length - 1].proxy)}</b>
        </span>
        <span>
          True quality <b>{f2(h[0].quality)} → {f2(h[h.length - 1].quality)}</b> (best {f2(h[peak].quality)} at step {peak})
        </span>
        <span>
          KL <b>{f2(h[h.length - 1].kl)}</b>
        </span>
      </div>
      <Distribution pi={run.pi} />
      <p className="small">
        {h[h.length - 1].quality < h[0].quality - 0.2 ? (
          <>
            <b>Reward hacking.</b> The score went up the whole time, but true quality peaked early and then fell below where it
            started: the model learned that the reward model likes length, and padded its answers. Raise β to keep it near the
            SFT model.
          </>
        ) : (
          <>
            <b>Contained{h[h.length - 1].quality > h[0].quality ? ', and better' : ''}.</b> The KL penalty keeps the model near the
            SFT model, so it moves only as far as the extra reward is worth the drift. True quality ends at{' '}
            {f2(h[h.length - 1].quality)} against {f2(h[0].quality)} at the start. Set β to 0 to see what happens without it.
          </>
        )}
      </p>
    </section>
  );
}

function Distribution({ pi }: { pi: number[] }) {
  return (
    <div className="pt-dist">
      {CANDIDATES.map((c, i) => (
        <div key={c.name} className="pt-dist-row">
          <span className="small">{c.name}</span>
          <div className="pt-dist-bars">
            <i className="ref" style={{ width: pct(REFERENCE[i]) }} title={`SFT model ${pct(REFERENCE[i])}`} />
            <i className="now" style={{ width: pct(pi[i]) }} title={`Tuned model ${pct(pi[i])}`} />
          </div>
          <span className="mono small">{pct(pi[i])}</span>
        </div>
      ))}
      <p className="small muted">
        <span className="pt-key ref" /> SFT model <span className="pt-key now" /> tuned model: how often each answer is chosen.
      </p>
    </div>
  );
}

const DPO_BETAS = [0.05, 0.1, 0.3, 1, 3];

function Dpo({ lengthBias, proxy }: { lengthBias: number; proxy: number[] }) {
  const [beta, setBeta] = useState(1);
  const pairs = useMemo(() => candidatePairs(lengthBias), [lengthBias]);
  const result = useMemo(() => dpo(pairs, beta), [pairs, beta]);
  const rl = useMemo(() => rlhf(proxy, beta), [proxy, beta]);
  const maxRatio = Math.max(...result.ratio.map(Math.abs), 0.5);
  return (
    <section className="pt-section">
      <h2>5. DPO: the same goal, no reward model, no RL</h2>
      <p>
        Direct Preference Optimisation trains the policy straight on the comparisons with one loss: for each pair, raise the
        chosen answer's log-probability relative to the reference, and lower the rejected one's:{' '}
        <span className="mono">−log σ(β[(log π(chosen) − log π_ref(chosen)) − (log π(rejected) − log π_ref(rejected))])</span>.
        Here: 200 comparisons between the eight answers, from the same labellers with the same liking for length.
      </p>
      <div className="row pt-controls">
        <span className="small">β</span>
        {DPO_BETAS.map((b) => (
          <button key={b} className={`chip-btn ${beta === b ? 'on' : ''}`} onClick={() => setBeta(b)}>
            {b}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="t pt-dpo">
          <thead>
            <tr>
              <th>Answer</th>
              <th className="num">Won its comparisons</th>
              <th>log π − log π_ref after DPO</th>
              <th className="num">Chosen now</th>
            </tr>
          </thead>
          <tbody>
            {CANDIDATES.map((c, i) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="num">{pct(result.wins[i])}</td>
                <td>
                  <div className="pt-diverge">
                    <i
                      className={result.ratio[i] >= 0 ? 'up' : 'down'}
                      style={
                        result.ratio[i] >= 0
                          ? { left: '50%', width: `${(result.ratio[i] / maxRatio) * 50}%` }
                          : { right: '50%', width: `${(-result.ratio[i] / maxRatio) * 50}%` }
                      }
                    />
                    <span className="mono">{result.ratio[i] >= 0 ? '+' : ''}{result.ratio[i].toFixed(1)}</span>
                  </div>
                </td>
                <td className="num">{pct(result.pi[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pt-readout">
        <span>
          DPO: true quality <b>{f2(expectedQuality(REFERENCE))} → {f2(result.quality)}</b>, KL <b>{f2(result.kl)}</b>
        </span>
        <span>
          RLHF in section 4 at the same β: true quality <b>{f2(rl.history[rl.history.length - 1].quality)}</b>, KL{' '}
          <b>{f2(rl.history[rl.history.length - 1].kl)}</b>
        </span>
      </div>
      <p className="small">
        Answers that usually won their comparisons go up; answers that usually lost go down. (An answer can fall a little
        even when it often wins, because the loss only cares about the gap between chosen and rejected.) β is the same leash
        as in RLHF: at small β, DPO chases the labellers' taste all the way to the padded answer; at larger β it stays near
        the reference. DPO needs no reward model and no sampling loop, but it learns the labellers' liking for length exactly
        as the reward model did.
      </p>
    </section>
  );
}

function Compare() {
  return (
    <section className="pt-section">
      <h2>6. RLHF with PPO, or DPO?</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th />
              <th>RLHF with PPO</th>
              <th>DPO</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Needs</td>
              <td>Preference pairs, a separate reward model, and an RL loop that generates answers during training</td>
              <td>Preference pairs only</td>
            </tr>
            <tr>
              <td>Models in memory</td>
              <td>Policy, reference, reward model, and usually a value model: four</td>
              <td>Policy and reference: two</td>
            </tr>
            <tr>
              <td>Cost and stability</td>
              <td>Expensive; many settings to tune; can be unstable</td>
              <td>Like supervised fine-tuning: cheaper and steadier</td>
            </tr>
            <tr>
              <td>Strengths</td>
              <td>Learns from fresh answers the model generates; the reward model can score anything later</td>
              <td>Simple to run; widely used for open models</td>
            </tr>
            <tr>
              <td>Where it is used</td>
              <td>InstructGPT and early ChatGPT; still used where an online reward is available</td>
              <td>Many open models (for example Zephyr, Llama 3's preference stage used DPO)</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small">
        Reasoning models add a third family: <b>GRPO</b> and related methods score groups of sampled answers against each
        other, often with a checkable reward (did the maths come out right?) instead of a learned one. That is Lab 32.
      </p>
    </section>
  );
}
