import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { GPT2 } from '@/lib/gpt2';
import { ModelFlow, type Tok } from './ModelFlow';
import {
  GPU,
  MODELS,
  big,
  energy,
  gpusFor,
  joulesForPrompt,
  joulesPerToken,
  opsPerToken,
  params,
  trainingGpuHours,
  trainingOps,
  type Assumptions,
} from './compute';
import './answer-power.css';

/** Questions with pre-written answers: the page shows the work a model does, not its words. */
const SAMPLES = [
  {
    q: 'Why is the sky blue?',
    a: 'Sunlight holds every colour. Air molecules scatter short blue waves far more than long red ones, so blue light reaches your eyes from all over the sky.',
  },
  {
    q: 'What is the capital of Australia?',
    a: 'The capital of Australia is Canberra, not Sydney. It was chosen as a compromise between Sydney and Melbourne.',
  },
  { q: 'Write a haiku about tokens.', a: 'Words split into parts, each part becomes a number, meaning in the sums.' },
];
const BATCHES = [1, 8, 32, 128];

/** What happens, and what it takes, when you ask a model something. */
export default function AnswerPowerPage() {
  const [sample, setSample] = useState(0);
  const [modelId, setModelId] = useState('llama70');
  const [batch, setBatch] = useState(32);
  const [utilisation, setUtilisation] = useState(0.4);
  const [ready, setReady] = useState(GPT2.isTokenizerReady());
  const [failed, setFailed] = useState(false);
  const [written, setWritten] = useState(0);

  useEffect(() => {
    if (ready || failed) return;
    let alive = true;
    GPT2.loadTokenizer()
      .then(() => alive && setReady(true))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [ready, failed]);

  const toks = (text: string): Tok[] =>
    ready ? (GPT2.encode(text) as number[]).map((id) => ({ id, text: GPT2.decode(id) as string })) : [];
  const s = SAMPLES[sample];
  const question = useMemo(() => toks(s.q), [s, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const answer = useMemo(() => toks(s.a), [s, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = MODELS.find((x) => x.id === modelId)!;
  const a: Assumptions = { batch, utilisation };
  const runKey = `${sample}|${modelId}|${batch}|${utilisation}|${ready}`;
  const smallest = MODELS[0];

  return (
    <main className="page-answer-power">
      <div className="kicker">Foundations · What it takes to answer</div>
      <h1>From your question to its answer, and the power it takes</h1>
      <p className="lede">
        A model never sees your words. Your question becomes a list of numbers, the numbers pass through every layer of
        the model, and out comes one more number: the next token. Then it does it all again for the token after that.
        The work for each token grows with the model&apos;s size, and so do the electricity and the price.
      </p>

      <div className="ap-controls card">
        <div className="ap-row">
          <span className="ap-label">Ask</span>
          <div className="ap-seg" role="radiogroup" aria-label="Question">
            {SAMPLES.map((x, i) => (
              <button
                key={x.q}
                type="button"
                role="radio"
                aria-checked={i === sample}
                className={i === sample ? 'on' : ''}
                onClick={() => setSample(i)}
              >
                {x.q}
              </button>
            ))}
          </div>
        </div>
        <div className="ap-row">
          <span className="ap-label">Model</span>
          <div className="ap-seg" role="radiogroup" aria-label="Model">
            {MODELS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={x.id === modelId}
                className={x.id === modelId ? 'on' : ''}
                onClick={() => setModelId(x.id)}
              >
                {x.name}
                <small>{params(x.total)}</small>
              </button>
            ))}
          </div>
          <span className="small muted">{m.note}</span>
        </div>
      </div>

      <div className="ap-text">
        <div>
          <span className="ap-tag">Your question, as the model sees it</span>
          {ready ? (
            <div className="ap-chips">
              {question.map((t, i) => (
                <span key={i} className="ap-chip q">
                  <b>{t.text.replace(/ /g, '·')}</b>
                  <i>{t.id}</i>
                </span>
              ))}
            </div>
          ) : (
            <p className="small muted">
              {failed ? (
                <>
                  The GPT-2 tokenizer could not be loaded (it comes from the internet), so the numbers cannot be shown.{' '}
                  <button type="button" className="btn small" onClick={() => setFailed(false)}>
                    Try again
                  </button>
                </>
              ) : (
                'Loading the GPT-2 tokenizer (2 MB)…'
              )}
            </p>
          )}
        </div>
        <div>
          <span className="ap-tag">The answer, one token at a time</span>
          <div className="ap-chips">
            {answer.slice(0, written).map((t, i) => (
              <span key={i} className={`ap-chip a${i === written - 1 ? ' new' : ''}`}>
                <b>{t.text.replace(/ /g, '·')}</b>
                <i>{t.id}</i>
              </span>
            ))}
            {written < answer.length && <span className="ap-caret" />}
          </div>
        </div>
      </div>

      <ModelFlow model={m} question={question} answer={answer} assumptions={a} runKey={runKey} onToken={setWritten} />
      <p className="small muted ap-under">
        The numbers are real GPT-2 token IDs (every model has its own vocabulary). The answers are written in advance:
        this page shows the work, not the model&apos;s words. Bigger models take longer on screen, as they do for real.
        A · stands for a space, which belongs to the token after it.
      </p>

      <h2>What the numbers go through</h2>
      <div className="ap-three">
        <div className="card">
          <h3>1. Words become numbers</h3>
          <p className="small">
            A tokenizer splits the text into pieces it knows and swaps each for its number in a fixed vocabulary: about
            50,000 for GPT-2, more for newer models. See <Link to="/tokens">the tokens lab</Link>.
          </p>
        </div>
        <div className="card">
          <h3>2. Numbers become meaning</h3>
          <p className="small">
            Each token number picks a list of numbers, {m.width.toLocaleString('en-GB')} of them in {m.name}. Every
            layer mixes in the other tokens (attention) and transforms the list, with billions of multiplications by its
            parameters. See <Link to="/transformer">the transformer explainer</Link>.
          </p>
        </div>
        <div className="card">
          <h3>3. Out comes one token</h3>
          <p className="small">
            The last layer scores every token in the vocabulary. One is chosen, turned back into text, added to the
            input, and the whole model runs again for the next. A 100-token answer is 100 passes. See{' '}
            <Link to="/sampling">sampling</Link>.
          </p>
        </div>
      </div>

      <h2>Parameters: what training left behind</h2>
      <p>
        Parameters are the numbers a model learned in training, tuned over trillions of tokens of text until they
        predict the next token well. What it learned lives in them, not in a copy of the training data: when it answers,
        it does not look anything up. So the cost of answering depends on the number of parameters, not on how much it
        read in training. A dense model uses every parameter for every token: about two operations each, a multiply and
        an add. A mixture of experts, such as DeepSeek-V3, sends each token through only some of its parts.
      </p>

      <h2>Bigger models need more power</h2>
      <div className="ap-assume card">
        <label>
          Batch: people served at once
          <select value={batch} onChange={(e) => setBatch(+e.target.value)}>
            {BATCHES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label>
          Share of the GPU&apos;s top speed reached <b>{Math.round(utilisation * 100)}%</b>
          <input
            type="range"
            min={0.1}
            max={0.8}
            step={0.05}
            value={utilisation}
            onChange={(e) => setUtilisation(+e.target.value)}
          />
        </label>
        <span className="small muted">
          On {GPU.name}: {GPU.flops / 1e12} trillion operations a second at most (16-bit), {GPU.memory / 1e9} GB of
          memory read at {GPU.bandwidth / 1e12} TB a second, up to {GPU.watts} W.
        </span>
      </div>
      <div className="ap-scroll">
        <table className="ap-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Parameters</th>
              <th className="num">GPUs to hold it</th>
              <th className="num">Work per token</th>
              <th className="num">Energy per token</th>
              <th className="num">A 300-token answer</th>
              <th>Compared with GPT-2</th>
            </tr>
          </thead>
          <tbody>
            {MODELS.map((x) => {
              const per = joulesPerToken(x, a).joules;
              const ans = joulesForPrompt(x, 30, a) + 300 * per;
              const base = joulesForPrompt(smallest, 30, a) + 300 * joulesPerToken(smallest, a).joules;
              return (
                <tr
                  key={x.id}
                  className={x.id === modelId ? 'on' : ''}
                  onClick={() => setModelId(x.id)}
                  tabIndex={0}
                  aria-selected={x.id === modelId}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setModelId(x.id);
                    }
                  }}
                >
                  <td>{x.name}</td>
                  <td className="num">
                    {x.total === x.active ? params(x.total) : `${params(x.total)} (${params(x.active)} at work)`}
                  </td>
                  <td className="num">{gpusFor(x)}</td>
                  <td className="num">{big(opsPerToken(x))}</td>
                  <td className="num">{energy(per)}</td>
                  <td className="num">{energy(ans)}</td>
                  <td>
                    <span className="ap-bar">
                      <span style={{ width: `${Math.min(100, (Math.log10(ans / base) / 4) * 100 + 4)}%` }} />
                    </span>
                    ×{Math.round(ans / base).toLocaleString('en-GB')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">
        Writing a token means reading every parameter it uses from memory. With one person at a time, the GPU mostly
        waits for memory; served together, many people share each read, so a token takes far less energy. That is one
        reason providers batch requests, and why the same model can cost less per token on a busy server. Try the batch
        size above.
      </p>

      <h2>Training once, answering every day</h2>
      <p>
        Training costs about six operations per parameter for every token it learns from: a pass forward and one back.
        It happens once; answering costs about two per parameter for every token, every time anyone asks.
      </p>
      <div className="ap-scroll">
        <table className="ap-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Trained on</th>
              <th className="num">Training operations</th>
              <th className="num">GPU hours at that speed</th>
              <th className="num">Energy, GPUs only</th>
            </tr>
          </thead>
          <tbody>
            {MODELS.filter((x) => x.trainedOn).map((x) => {
              const hours = trainingGpuHours(x, utilisation)!;
              return (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td className="num">{big(x.trainedOn!)} tokens</td>
                  <td className="num">{big(trainingOps(x)!)}</td>
                  <td className="num">{big(hours)}</td>
                  <td className="num">{energy(hours * 3600 * GPU.watts)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        For Llama 3.1 405B, Meta reported about 30.8 million H100 hours; at {Math.round(utilisation * 100)}% of top
        speed this estimate gives {big(trainingGpuHours(MODELS[3], utilisation)!)}. Training energy here counts the GPUs
        only; the rest of the data centre adds more.
      </p>

      <h2>What this means for the price</h2>
      <ul className="ap-take">
        <li>
          <b>A bigger model does more work for every token</b>, needs more GPUs to hold it, and costs more to run. That
          is the main reason a larger model&apos;s price per token is higher, as on the{' '}
          <Link to="/effort-and-cost">model, effort and cost</Link> page.
        </li>
        <li>
          <b>Thinking is tokens too.</b> A model that reasons before answering writes more tokens, and every one is a
          full pass through the model.
        </li>
        <li>
          <b>Pick the smallest model that does the job well</b>, measured on your own examples. Use a bigger one where
          it earns its cost.
        </li>
      </ul>
      <p className="small muted">
        Sizes are the published figures of open models; Anthropic and OpenAI do not publish theirs. Energy figures are
        estimates for one GPU type, with 16-bit weights and a fifth of memory kept free for the conversation, and they
        leave out cooling and the rest of the data centre. Real services use lower-precision numbers, other chips and
        their own batching, so treat the figures as the shape of the cost, not a bill. For DeepSeek-V3 the estimate is a
        best case: a batch&apos;s tokens use more of its experts than one token does.
      </p>
    </main>
  );
}
