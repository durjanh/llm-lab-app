import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './sampling.css';

export default function SamplingPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-sampling">
      <div className="kicker">Lab 2 · Sampling</div>
      <h1>How the next word gets picked</h1>
      <p className="lede">
        The model only gives you a probability for every possible next token. The decoding settings decide which one you
        actually get. Run the same prompt under three settings and compare what comes out.
      </p>
      <div id="gate" />
      <section className="needs-model locked" id="lab">
        <div className="card">
          <div className="controls">
            <label>
              Prompt
              <input
                type="text"
                id="prompt"
                defaultValue="The best way to learn programming is"
                style={{ width: '100%' }}
              />
            </label>{' '}
            <label>
              Examples
              <select id="examples">
                <option>The best way to learn programming is</option>
                <option>As the spaceship was approaching the</option>
                <option>Once upon a time there was a</option>
                <option>The capital of France is</option>
                <option>My favourite thing about the weekend is</option>
              </select>
            </label>
            <div className="row full">
              <label>
                New tokens <input type="range" id="maxTok" min="5" max="40" defaultValue="24" />{' '}
                <span className="mono" id="maxTokV">
                  24
                </span>
              </label>{' '}
              <label>
                Samples per setting <input type="range" id="nSamp" min="1" max="4" defaultValue="3" />{' '}
                <span className="mono" id="nSampV">
                  3
                </span>
              </label>{' '}
              <label>
                <input type="checkbox" id="fixSeed" defaultChecked /> Fixed seed
              </label>{' '}
              <input type="number" id="seed" defaultValue="42" aria-label="Seed" style={{ width: '80px' }} />{' '}
              <span className="spacer" />{' '}
              <button className="btn primary" id="run">
                Run
              </button>{' '}
              <button className="btn" id="stop" disabled>
                Stop
              </button>
            </div>
          </div>
        </div>
        <div className="row" style={{ margin: '14px 0 4px' }}>
          <span className="conf-legend">
            How sure the model was about each token: <i style={{ background: 'var(--surface)' }} /> 70%+{' '}
            <i style={{ background: 'rgba(235,104,52,.16)' }} /> 40–70%{' '}
            <i style={{ background: 'rgba(235,104,52,.38)' }} /> 15–40%{' '}
            <i style={{ background: 'rgba(235,104,52,.66)' }} /> under 15%
          </span>{' '}
          <span className="small muted">Hover any generated token to see the alternatives it beat.</span>
        </div>
        <div className="grid3" id="cfgs" />
        <p className="small muted" style={{ marginTop: '10px' }}>
          <b>Average confidence</b> is the model's own probability for the tokens that were picked. <b>Diversity</b> is
          the share of word pairs that are unique across samples. <b>Loops</b> counts repeated three-token phrases, a
          sign of getting stuck.
        </p>
      </section>
      <section>
        <h2>What each setting does</h2>
        <div className="grid2">
          <div className="card">
            <h3 style={{ marginTop: '0' }}>Temperature</h3>
            <p>
              Divides every score before they become probabilities. Below 1 the favourite gets stronger. Above 1 the
              long tail gets a real chance. At 0 the model always takes its top choice, which is called greedy decoding.
            </p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: '0' }}>Top-k</h3>
            <p>
              Keeps only the k most likely tokens and throws the rest away. It is a fixed-size safety net against very
              unlikely picks. Set it to 0 here to turn it off.
            </p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: '0' }}>Top-p</h3>
            <p>
              Keeps the smallest set of tokens whose probabilities add up to p. The set shrinks when the model is
              confident and grows when it is unsure, so it adapts better than top-k.
            </p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: '0' }}>Repetition penalty</h3>
            <p>
              Lowers the score of tokens that already appeared. Greedy decoding on small models loops easily; try a
              penalty of 1.3 on the greedy column and watch the loops count fall.
            </p>
          </div>
        </div>
        <h2>What your API actually lets you change</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Open-weight models you host (vLLM, llama.cpp, Hugging Face)</th>
                <th>Claude API</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Temperature, top-p, top-k</td>
                <td>Yes</td>
                <td>
                  Older models such as Claude Sonnet 4.6 and Claude Haiku 4.5 accept them. Current models such as Claude
                  Opus 5.5 reject them, and Claude Sonnet 5.5 and Claude Haiku 5.5 reject anything but the defaults.
                </td>
              </tr>
              <tr>
                <td>Repetition penalty, min-p, seed</td>
                <td>Usually yes</td>
                <td>No</td>
              </tr>
              <tr>
                <td>Your levers on current Claude models</td>
                <td />
                <td>
                  Clear instructions and examples, structured outputs for machine-read results, and the{' '}
                  <code>effort</code> setting for how hard the model thinks.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h2>Starting points by task</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Task</th>
                <th>Setting to start from</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Extraction, classification, code edits</td>
                <td>Greedy, or temperature 0 to 0.3</td>
                <td>You want the single most likely answer every time.</td>
              </tr>
              <tr>
                <td>Chat assistant</td>
                <td>Temperature 0.5 to 0.8, top-p 0.9</td>
                <td>Natural variety without drifting into nonsense.</td>
              </tr>
              <tr>
                <td>Brainstorming and creative writing</td>
                <td>Temperature 0.9 to 1.2, top-p 0.95</td>
                <td>More surprising options, so review the output.</td>
              </tr>
              <tr>
                <td>Hard reasoning questions</td>
                <td>Moderate temperature, 5 to 10 samples, majority vote</td>
                <td>Independent samples cancel out one-off mistakes. This is called self-consistency.</td>
              </tr>
              <tr>
                <td>Testing a prompt</td>
                <td>Production settings, several runs per test case</td>
                <td>One sample hides how much the output varies.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Change one knob at a time.</b> Temperature and top-p both widen or narrow the choice, so tuning both at
            once makes results hard to reason about.
          </li>
          <li>
            <b>Greedy is close to repeatable, not guaranteed.</b> Hosted APIs can still vary slightly between identical
            calls because of batching and floating-point effects. Design for that.
          </li>
          <li>
            <b>Low-confidence tokens are where the model guesses.</b> A name, date or number picked at 10% is a
            hallucination risk. Some APIs return per-token log probabilities that you can use to flag shaky answers for
            review.
          </li>
          <li>
            <b>On current Claude models, steer with the prompt, not the sampler.</b> Use examples, structured outputs
            and effort instead of temperature.
          </li>
          <li>
            <b>Sampling is a feature for evaluation.</b> Running a prompt several times shows its spread, and majority
            voting turns that spread into accuracy.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
        <p className="small" style={{ margin: '10px 0 0' }}>
          Runnable version: <code>python/02_self_consistency.py</code>. Setup is in <code>python/README.md</code>.
        </p>
      </div>
    </main>
  );
}
