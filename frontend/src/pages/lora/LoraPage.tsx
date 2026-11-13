import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  loraService,
  type LoraAdapter,
  type LoraConfig,
  type LoraEval,
  type LoraEvent,
  type LoraInfo,
  type LoraMetrics,
  type LoraModel,
  type LoraResult,
  type LoraTryResult,
} from '@/services/loraService';
import './lora.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const count = (v: number) => v.toLocaleString('en-GB');
const mb = (bytes: number) => `${(bytes / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 1 })} MB`;
const millions = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)} bn` : `${(v / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 2 })} m`;

const PRESETS: Record<string, string[]> = {
  'Attention only (q, v)': ['q_proj', 'v_proj'],
  'All attention': ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
  'Every linear layer': ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
};

/** The same sum as lora_data.lora_params: r x (inputs + outputs) for each targeted matrix in each layer. */
function adapterParams(m: LoraModel, r: number, targets: string[]): number {
  const h = m.hidden;
  const shape: Record<string, [number, number]> = {
    q_proj: [h, h],
    k_proj: [h, m.kv],
    v_proj: [h, m.kv],
    o_proj: [h, h],
    gate_proj: [h, m.intermediate],
    up_proj: [h, m.intermediate],
    down_proj: [m.intermediate, h],
  };
  return m.layers * targets.reduce((sum, t) => sum + r * (shape[t][0] + shape[t][1]), 0);
}

/** The training loss, step by step, drawn as it arrives. */
function LossChart({ points, steps }: { points: { step: number; loss: number }[]; steps: number }) {
  const w = 640;
  const h = 200;
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const top = Math.max(0.05, ...points.map((p) => p.loss));
  const x = (s: number) => pad.l + ((s - 1) / Math.max(1, steps - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (h - pad.t - pad.b);
  const ticks = [0, top / 2, top];
  return (
    <svg className="lr-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Training loss by step">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      <text x={pad.l} y={h - 6}>
        step 1
      </text>
      <text x={w - pad.r} y={h - 6} textAnchor="end">
        step {steps}
      </text>
      {points.length > 1 && (
        <polyline className="line" points={points.map((p) => `${x(p.step)},${y(p.loss)}`).join(' ')} />
      )}
    </svg>
  );
}

const ROWS: { key: string; label: string; of: (m: LoraMetrics) => number }[] = [
  { key: 'valid_json', label: 'Answers that are valid JSON', of: (m) => m.valid_json },
  { key: 'right_keys', label: 'Exactly the five keys asked for', of: (m) => m.right_keys },
  { key: 'all_fields', label: 'Every field right', of: (m) => m.all_fields },
];

/** Before and after on the held-out emails, as bars. */
function Scores({ before, after, fields }: { before: LoraMetrics; after?: LoraMetrics; fields: string[] }) {
  const rows = [
    ...ROWS,
    ...fields.map((f) => ({ key: f, label: `“${f}” right`, of: (m: LoraMetrics) => m.fields[f] ?? 0 })),
  ];
  return (
    <table className="t lr-scores">
      <thead>
        <tr>
          <th>On {before.n} emails it never saw</th>
          <th>Base model</th>
          <th>With the adapter</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.key === 'all_fields' ? 'lr-main' : ''}>
            <td>{r.label}</td>
            {[before, after].map((m, i) => (
              <td key={i}>
                {m ? (
                  <span className="lr-bar">
                    <i className={i ? 'after' : ''} style={{ width: `${r.of(m) * 100}%` }} />
                    <b>{pct(r.of(m))}</b>
                  </span>
                ) : (
                  <span className="muted">…</span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One email with what each model wrote, and which fields each got right. */
function Sample({ i, before, after, fields }: { i: number; before: LoraEval; after?: LoraEval; fields: string[] }) {
  const s = before.samples[i];
  const a = after?.samples[i];
  return (
    <div className="lr-sample">
      <pre className="lr-email">{s.email}</pre>
      {[
        { name: 'Base model', out: s },
        { name: 'With the adapter', out: a },
      ].map(({ name, out }) => (
        <div key={name} className="lr-out">
          <div className="small muted">{name}</div>
          {out ? (
            <>
              <pre>{out.output || '(nothing)'}</pre>
              <div className="lr-ticks">
                {fields.map((f) => (
                  <span key={f} className={out.fields[f] ? 'ok' : 'no'}>
                    {out.fields[f] ? '✓' : '✗'} {f}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="muted small">After training.</p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Fine-tuning with LoRA: a small open model learns a fixed JSON format on this machine, scored before and after. */
export default function LoraPage() {
  const [info, setInfo] = useState<LoraInfo | null>(null);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<LoraConfig>({
    model_id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    r: 16,
    alpha: 32,
    dropout: 0.05,
    targets: PRESETS['Every linear layer'],
    lr: 5e-4,
    steps: 80,
    batch: 8,
    seed: 0,
  });
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [setup, setSetup] = useState<{ device: string; dtype: string } | null>(null);
  const [params, setParams] = useState<{ trainable: number; total: number; share: number } | null>(null);
  const [loss, setLoss] = useState<{ step: number; loss: number }[]>([]);
  const [live, setLive] = useState<{ elapsed_s: number; memory_mb: number; step: number } | null>(null);
  const [before, setBefore] = useState<LoraEval | null>(null);
  const [after, setAfter] = useState<LoraEval | null>(null);
  const [result, setResult] = useState<LoraResult | null>(null);
  const [email, setEmail] = useState(
    'Hello,\n\nI bought a desk lamp last week, order NW-55120, and it arrived with the shade cracked. Could you send a new one?\n\nThanks,\nPriya Shah',
  );
  const [tryAdapter, setTryAdapter] = useState<string>('');
  const [tried, setTried] = useState<LoraTryResult | null>(null);
  const [trying, setTrying] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const refresh = () =>
    loraService
      .info()
      .then((i) => {
        setInfo(i);
        setTryAdapter((current) => current || i.adapters[0]?.id || '');
      })
      .catch((err) => setError(errorText(err)));

  useEffect(() => {
    void refresh();
    return () => abort.current?.abort();
  }, []);

  const model = info?.models.find((m) => m.id === config.model_id);
  const planned = useMemo(
    () => (model ? adapterParams(model, config.r, config.targets) : 0),
    [model, config.r, config.targets],
  );
  const set = <K extends keyof LoraConfig>(key: K, value: LoraConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));

  function onEvent(e: LoraEvent) {
    if (e.type === 'progress') setLog((l) => [...l, e.step]);
    else if (e.type === 'setup') setSetup({ device: e.device, dtype: e.dtype });
    else if (e.type === 'params') setParams(e);
    else if (e.type === 'step') {
      setLoss((l) => [...l, { step: e.step, loss: e.loss }]);
      setLive({ elapsed_s: e.elapsed_s, memory_mb: e.memory_mb, step: e.step });
    } else if (e.type === 'eval') {
      if (e.phase === 'before') {
        setBefore(e);
        if (e.cached) setLog((l) => [...l, 'Base model scores reused from an earlier run (same model, same emails)']);
      } else setAfter(e);
    } else if (e.type === 'merge')
      setLog((l) => [
        ...l,
        `Merged the adapter into the weights: largest change in any output score ${e.max_logit_difference.toExponential(1)}, so the answers are the same`,
      ]);
    else if (e.type === 'result') setResult(e);
    else if (e.type === 'done') {
      setTryAdapter(e.adapter_id);
      void refresh();
    } else if (e.type === 'error') setError(e.message);
  }

  async function train() {
    setError('');
    setLog([]);
    setLoss([]);
    setLive(null);
    setParams(null);
    setBefore(null);
    setAfter(null);
    setResult(null);
    setSetup(null);
    setRunning(true);
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      await loraService.train(config, onEvent, abort.current.signal);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(errorText(err));
    } finally {
      setRunning(false);
    }
  }

  async function cancel() {
    await loraService.cancel().catch(() => undefined);
  }

  async function runTry() {
    setTrying(true);
    setError('');
    setTried(null);
    try {
      setTried(await loraService.tryEmail(email, tryAdapter || null));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTrying(false);
    }
  }

  async function remove(a: LoraAdapter) {
    if (!window.confirm('Delete this adapter?')) return;
    try {
      await loraService.remove(a.id);
      if (tryAdapter === a.id) setTryAdapter('');
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const fields = info?.fields ?? [];
  const adapters = info?.adapters ?? [];

  return (
    <main className="page-lora">
      <div className="kicker">Building · Fine-tuning with LoRA</div>
      <h1>Teach a small model a new habit in about a minute, on this machine</h1>
      <p className="lede">
        LoRA fine-tunes a model without touching its weights: it trains two thin matrices beside each chosen layer, well
        under 5% of the model’s size, and adds their product to the layer’s output. Here a 135-million-parameter open
        model learns to turn customer emails into one JSON object in a fixed shape. Code writes the emails and the right
        answers, and scores the model on emails it never saw, before and after. Training runs on this machine and costs
        nothing. For the theory, see <Link to="/training-at-scale">Training at scale</Link> and{' '}
        <Link to="/preference-tuning">Preference tuning</Link>.
      </p>

      {info && !info.ready && (
        <div className="lr-setup small">
          The training environment is not installed. From the repo root run: <code>{info.setup}</code> (about 1 GB,
          mostly PyTorch). The first run then downloads the model (270 MB) into <code>generated/lora/models</code>.
        </div>
      )}
      {error && <p className="lr-bad small">{error}</p>}

      <section className="card lr-step">
        <h2>1. The task</h2>
        <p className="small">
          {info?.dataset.train} invented emails to learn from, {info?.dataset.test} held back for scoring. Each asks for
          the customer, the order number, the product, the issue (one of four) and what they want (one of three), in
          everyday words: “arrived cracked” is <span className="mono">damaged</span>, “can I have my money back” is{' '}
          <span className="mono">refund</span>.
        </p>
        <details>
          <summary className="small">The instruction both models get</summary>
          <pre className="lr-pre">{info?.system}</pre>
        </details>
        <div className="lr-examples">
          {info?.dataset.examples.slice(0, 2).map((e, i) => (
            <div key={i}>
              <pre className="lr-email">{e.email}</pre>
              <pre className="lr-pre">{e.target}</pre>
            </div>
          ))}
        </div>
      </section>

      <section className="card lr-step">
        <h2>2. Settings</h2>
        <div className="lr-form">
          <label>
            Model
            <select value={config.model_id} onChange={(e) => set('model_id', e.target.value)} disabled={running}>
              {info?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label title="The inner width of the two matrices. Bigger can learn more, and trains more numbers.">
            Rank r
            <select value={config.r} onChange={(e) => set('r', Number(e.target.value))} disabled={running}>
              {[2, 4, 8, 16, 32, 64].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label title="The adapter's output is scaled by alpha / r. Twice r is a common start.">
            Alpha
            <select value={config.alpha} onChange={(e) => set('alpha', Number(e.target.value))} disabled={running}>
              {[4, 8, 16, 32, 64, 128].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Learning rate
            <select value={config.lr} onChange={(e) => set('lr', Number(e.target.value))} disabled={running}>
              {[1e-4, 2e-4, 5e-4, 1e-3, 2e-3].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label title="Each step learns from 8 emails.">
            Steps
            <select value={config.steps} onChange={(e) => set('steps', Number(e.target.value))} disabled={running}>
              {[10, 20, 40, 80, 150, 300].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="lr-targets">
          <span className="small">Layers to adapt:</span>
          {info?.targets.map((t) => (
            <label key={t} className="small">
              <input
                type="checkbox"
                checked={config.targets.includes(t)}
                disabled={running}
                onChange={(e) =>
                  set(
                    'targets',
                    e.target.checked
                      ? info.targets.filter((x) => x === t || config.targets.includes(x))
                      : config.targets.filter((x) => x !== t),
                  )
                }
              />{' '}
              <span className="mono">{t}</span>
            </label>
          ))}
          {Object.entries(PRESETS).map(([name, list]) => (
            <button key={name} className="btn small" disabled={running} onClick={() => set('targets', list)}>
              {name}
            </button>
          ))}
        </div>
        {model && (
          <p className="small">
            This trains <b>{count(planned)}</b> numbers, {((planned / model.params) * 100).toFixed(2)}% of the model’s{' '}
            {millions(model.params)}; the rest stay frozen. The adapter file will be about {mb(planned * 4)} (32-bit),
            against {mb(model.params * 2)} for the model.
          </p>
        )}
        <div className="lr-row">
          <button
            className="btn primary"
            disabled={!info?.ready || running || config.targets.length === 0}
            onClick={() => void train()}
          >
            Train
          </button>
          {running && (
            <button className="btn" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
          <span className="small muted">
            {info?.machine}. About a minute for 80 steps on the 135M model; the first run also downloads it.
          </span>
        </div>
      </section>

      {(running || log.length > 0) && (
        <section className="card lr-step" aria-live="polite">
          <h2>3. Training</h2>
          <ul className="lr-log small">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <div className="lr-stats small">
            {setup && (
              <span>
                <b>Device</b> {setup.device.toUpperCase()}, {setup.dtype}
              </span>
            )}
            {params && (
              <span>
                <b>Trained</b> {count(params.trainable)} of {count(params.total)} ({(params.share * 100).toFixed(2)}%)
              </span>
            )}
            {live && (
              <>
                <span>
                  <b>Step</b> {live.step} of {config.steps}
                </span>
                <span>
                  <b>Time</b> {live.elapsed_s} s
                </span>
                <span title="What the GPU driver holds for this process, caches included">
                  <b>GPU memory</b> {(live.memory_mb / 1000).toFixed(1)} GB
                </span>
              </>
            )}
          </div>
          {loss.length > 0 && (
            <>
              <LossChart points={loss} steps={config.steps} />
              <p className="small muted">
                Loss is how surprised the model is by the right answer, averaged over its tokens. Only the answer
                counts: the email’s tokens are masked, so it learns to write the JSON, not to repeat the email.
              </p>
            </>
          )}
        </section>
      )}

      {before && (
        <section className="card lr-step">
          <h2>4. Before and after</h2>
          <Scores before={before.metrics} after={after?.metrics} fields={fields} />
          {result && (
            <p className="small">
              Training took {result.train_s} s ({result.total_s} s with loading and scoring). The adapter file is{' '}
              <b>{mb(result.sizes.adapter_bytes)}</b>; the model it changes is {mb(result.sizes.base_bytes)}. Final loss{' '}
              {result.final_loss}.{' '}
              {result.merge.max_logit_difference !== undefined && (
                <>
                  Merging the adapter into the weights changed no output score by more than{' '}
                  {result.merge.max_logit_difference.toExponential(1)}: the same model, with no extra work per token.
                </>
              )}
            </p>
          )}
          <h3>Three of the held-out emails</h3>
          {[0, 1, 2].map((i) =>
            before.samples[i] ? (
              <Sample key={i} i={i} before={before} after={after ?? undefined} fields={fields} />
            ) : null,
          )}
        </section>
      )}

      <section className="card lr-step">
        <h2>5. Try an email of your own</h2>
        <textarea className="lr-textarea" rows={6} value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="lr-row">
          <select value={tryAdapter} onChange={(e) => setTryAdapter(e.target.value)} disabled={trying}>
            <option value="">Base model only</option>
            {adapters.map((a) => (
              <option key={a.id} value={a.id}>
                Adapter {a.id.slice(0, 6)}: r {a.config.r}, {a.config.steps} steps, {pct(a.after.all_fields)} right
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={!info?.ready || trying || running || email.trim().length < 10}
            onClick={() => void runTry()}
          >
            {trying ? 'Running…' : 'Run'}
          </button>
          <span className="small muted">Loads the model each time, so allow a few seconds.</span>
        </div>
        {tried && (
          <div className="lr-try">
            <div className="lr-out">
              <div className="small muted">Base model {tried.base_json ? '· valid JSON' : '· not JSON'}</div>
              <pre>{tried.base || '(nothing)'}</pre>
            </div>
            {tried.adapter !== null && (
              <div className="lr-out">
                <div className="small muted">With the adapter {tried.adapter_json ? '· valid JSON' : '· not JSON'}</div>
                <pre>{tried.adapter || '(nothing)'}</pre>
              </div>
            )}
          </div>
        )}
      </section>

      {adapters.length > 0 && (
        <section className="card lr-step">
          <h2>Saved adapters</h2>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Adapter</th>
                  <th>Model</th>
                  <th>r / alpha</th>
                  <th>Layers</th>
                  <th>Steps, lr</th>
                  <th>Trained</th>
                  <th>Every field right</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {adapters.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.id.slice(0, 6)}</td>
                    <td>{a.model_id?.split('/')[1]?.replace('-Instruct', '')}</td>
                    <td className="mono">
                      {a.config.r} / {a.config.alpha}
                    </td>
                    <td className="small">{a.config.targets?.join(', ')}</td>
                    <td className="mono">
                      {a.config.steps}, {a.config.lr}
                    </td>
                    <td className="mono">{a.train_s} s</td>
                    <td className="mono">
                      {pct(a.before.all_fields)} → <b>{pct(a.after.all_fields)}</b>
                    </td>
                    <td className="mono">{a.sizes.adapter_bytes ? mb(a.sizes.adapter_bytes) : '–'}</td>
                    <td>
                      <button className="lr-link small" onClick={() => void remove(a)}>
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Train again with a smaller rank, fewer layers or fewer steps, and compare: the task is narrow, so a small
            adapter often does as well as a big one.
          </p>
        </section>
      )}

      <h2>Memory: full fine-tuning, LoRA and QLoRA</h2>
      <p className="small">
        Worked out by code from each model’s published shape, for rank 16 on every linear layer. It counts the weights,
        gradients and AdamW’s state; activations come on top and grow with batch size and text length.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Model</th>
              <th>Parameters</th>
              <th>Adapter</th>
              <th>Full fine-tune</th>
              <th>LoRA</th>
              <th>QLoRA</th>
            </tr>
          </thead>
          <tbody>
            {info?.memory.map((m) => (
              <tr key={m.label}>
                <td>{m.label}</td>
                <td className="mono">{millions(m.params)}</td>
                <td className="mono">
                  {millions(m.adapter_params)} ({(m.adapter_share * 100).toFixed(2)}%)
                </td>
                <td className="mono">{m.full_gb} GB</td>
                <td className="mono">{m.lora_gb} GB</td>
                <td className="mono">{m.qlora_gb} GB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="lr-facts small">
        <li>
          <b>Full fine-tuning</b>: about 16 bytes for every parameter (16-bit weights and gradients, a 32-bit master
          copy, and Adam’s two 32-bit moments). An 8-billion-parameter model needs well over 100 GB.
        </li>
        <li>
          <b>LoRA</b>: the frozen model at 2 bytes a parameter, and the 16 bytes only for the adapter.
        </li>
        <li>
          <b>QLoRA</b>: the frozen model stored in 4-bit NF4 (about half a byte a parameter, with its scales), the
          adapter still trained in 16-bit. That is how an 8B model trains on one 24 GB graphics card.
        </li>
        <li>
          <b>On this Mac</b>: QLoRA’s 4-bit loading comes from bitsandbytes, which needs an NVIDIA GPU with CUDA, so
          this page trains LoRA on the full-precision model. The script has the 4-bit path for a CUDA machine (
          <span className="mono">"quantize": "4bit"</span>); it has not been run here.
        </li>
      </ul>

      <h2>How LoRA works</h2>
      <ul className="lr-facts">
        <li>
          <b>Two thin matrices.</b> Beside a frozen weight matrix W (d × k), LoRA trains B (d × r) and A (r × k), with r
          small (here 16). The layer computes W·x + (alpha / r)·B·A·x. B starts at zero, so training starts from the
          unchanged model.
        </li>
        <li>
          <b>Why it works.</b> The change a task needs is usually low-rank: a few directions, not a whole new matrix.
          Rank 16 on a 576 × 576 matrix trains 18,432 numbers instead of 331,776.
        </li>
        <li>
          <b>Merging.</b> B·A is just a d × k matrix, so after training it can be added into W once. The merged model is
          the same size and speed as the original; the check above shows the answers do not change. Unmerged, one base
          model can carry many small adapters and swap them per request.
        </li>
        <li>
          <b>When to use it.</b> To teach a format, a style, a narrow skill or a domain’s vocabulary that prompting does
          not get reliably. Not to add facts that change: retrieval (the <Link to="/vector-db">vector database</Link>)
          is better for those.
        </li>
      </ul>
    </main>
  );
}
