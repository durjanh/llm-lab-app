import { useEffect, useRef, useState } from 'react';
import { isLocalModel } from '@/lib/models';
import { statusService } from '@/services/statusService';
import {
  tabularService,
  type ModelResult,
  type TabularInfo,
  type TabularResult,
  type TabularTable,
  type TabularTask,
} from '@/services/tabularService';
import './tabular.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;

const METRICS: Record<TabularTask, { key: string; label: string; better: 'high' | 'low'; help: string }[]> = {
  classification: [
    { key: 'accuracy', label: 'Accuracy', better: 'high', help: 'Share of test rows predicted right' },
    {
      key: 'balanced_accuracy',
      label: 'Balanced accuracy',
      better: 'high',
      help: 'Accuracy averaged over the classes, so a rare class counts as much as a common one',
    },
    {
      key: 'roc_auc',
      label: 'ROC AUC',
      better: 'high',
      help: 'How well the model ranks positives above negatives, from 0.5 (chance) to 1',
    },
  ],
  regression: [
    { key: 'r2', label: 'R²', better: 'high', help: 'Share of the variation explained, 1 is perfect' },
    { key: 'rmse', label: 'RMSE', better: 'low', help: 'Typical error, in the target’s units; big misses count more' },
    { key: 'mae', label: 'MAE', better: 'low', help: 'Average error, in the target’s units' },
  ],
};

const NAMES = { tabpfn: 'TabPFN', gradient_boosting: 'Gradient boosting' } as const;
type ModelKey = keyof typeof NAMES;

const fmt = (v: number | null | undefined) =>
  v === null || v === undefined
    ? '–'
    : Math.abs(v) >= 1000
      ? v.toLocaleString('en-GB', { maximumFractionDigits: 0 })
      : String(v);

/** Bars for one metric, both models side by side. */
function Bars({ result, metric }: { result: TabularResult; metric: (typeof METRICS)[TabularTask][number] }) {
  const values = (Object.keys(NAMES) as ModelKey[]).map((k) => result.results[k].metrics[metric.key] ?? 0);
  const top = Math.max(...values.map(Math.abs), 1e-9);
  const best = metric.better === 'high' ? Math.max(...values) : Math.min(...values);
  return (
    <div className="tb-bars">
      <div className="tb-bars-head">
        <b>{metric.label}</b> <span className="muted small">{metric.help}</span>
      </div>
      {(Object.keys(NAMES) as ModelKey[]).map((k, i) => (
        <div key={k} className="tb-bar-row">
          <span>{NAMES[k]}</span>
          <span className="tb-bar">
            <i
              className={values[i] === best ? 'best' : ''}
              style={{ width: `${(Math.abs(values[i]) / top) * 100}%` }}
            />
          </span>
          <span className="mono">{fmt(result.results[k].metrics[metric.key])}</span>
        </div>
      ))}
    </div>
  );
}

/** Predicted against actual for a regression, both models on one small chart. */
function Scatter({ result }: { result: TabularResult }) {
  const all = (Object.keys(NAMES) as ModelKey[]).flatMap((k) => result.results[k].scatter ?? []);
  if (!all.length) return null;
  const lo = Math.min(...all.flat());
  const hi = Math.max(...all.flat());
  const s = (v: number) => 10 + ((v - lo) / (hi - lo || 1)) * 280;
  return (
    <figure className="tb-scatter">
      <svg viewBox="0 0 300 300" role="img" aria-label="Predicted against actual values">
        <line x1="10" y1="290" x2="290" y2="10" className="tb-diag" />
        {(Object.keys(NAMES) as ModelKey[]).map((k) =>
          (result.results[k].scatter ?? []).map(([a, p], i) => (
            <circle key={`${k}${i}`} cx={s(a)} cy={300 - s(p)} r="2.4" className={`tb-dot ${k}`} />
          )),
        )}
      </svg>
      <figcaption className="small muted">
        Predicted (up) against actual (across). On the diagonal is a perfect prediction.{' '}
        <span className="tb-key tabpfn">TabPFN</span>{' '}
        <span className="tb-key gradient_boosting">Gradient boosting</span>
      </figcaption>
    </figure>
  );
}

function Confusion({ name, r }: { name: string; r: ModelResult }) {
  const c = r.metrics.confusion;
  if (!c) return null;
  return (
    <div>
      <p className="small">
        <b>{name}</b>: rows are the real class, columns the prediction
      </p>
      <table className="t tb-confusion">
        <thead>
          <tr>
            <th />
            {c.labels.map((l) => (
              <th key={l}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.matrix.map((row, i) => (
            <tr key={i}>
              <th>{c.labels[i]}</th>
              {row.map((v, j) => (
                <td key={j} className={i === j ? 'hit' : ''}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tabular foundation models: TabPFN against gradient boosting on a table, with an agent that picks the target. */
export default function TabularPage() {
  const [info, setInfo] = useState<TabularInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [table, setTable] = useState<TabularTable | null>(null);
  const [target, setTarget] = useState('');
  const [task, setTask] = useState<TabularTask>('classification');
  const [why, setWhy] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<TabularResult | null>(null);
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([tabularService.info(), statusService.status()])
      .then(([i, s]) => {
        setInfo(i);
        const offered = s.models || [];
        setModels(offered);
        setModel(offered.includes(i.model) ? i.model : s.claude_model || offered[0] || '');
      })
      .catch((err) => setError(errorText(err)));
    return () => abort.current?.abort();
  }, []);

  function loaded(t: TabularTable) {
    setTable(t);
    setTarget('');
    setWhy('');
    setResult(null);
    setExplanation('');
    setSteps([]);
  }

  async function load(work: () => Promise<TabularTable>) {
    setBusy('Reading the table…');
    setError('');
    try {
      loaded(await work());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function suggest() {
    if (!table) return;
    setBusy('Asking the model what to predict…');
    setError('');
    try {
      const s = await tabularService.suggest(table.table_id, model || undefined);
      setTarget(s.target);
      setTask(s.task);
      setWhy(s.why);
      setCost((c) => c + s.cost_usd);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function run() {
    if (!table || !target) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy('Running both models…');
    setError('');
    setResult(null);
    setExplanation('');
    setSteps([]);
    try {
      await tabularService.run(
        table.table_id,
        target,
        task,
        model || undefined,
        (e) => {
          if (e.type === 'progress') setSteps((s) => [...s, e.step]);
          else if (e.type === 'result') setResult(e.result);
          else if (e.type === 'done') {
            setExplanation(e.explanation);
            setCost((c) => c + e.cost_usd);
          } else if (e.type === 'error') setError(e.message);
        },
        abort.current.signal,
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  const col = table?.columns.find((c) => c.name === target);

  return (
    <main className="page-tabular">
      <div className="kicker">Building · Tabular foundation models</div>
      <h1>A model pre-trained on tables, against trees trained on yours</h1>
      <p className="lede">
        Language models are not built to predict from spreadsheets. A tabular foundation model is: TabPFN was
        pre-trained on millions of invented tables, and predicts a new one by reading its rows as context, with no
        training on your data. Here it races gradient boosting, the usual first choice, on the same split. A model
        suggests what to predict and explains the result; code computes every number.
      </p>

      {info && !info.ready && (
        <div className="tb-setup small">
          TabPFN is not installed on this machine. From the repo root run: <code>{info.setup}</code> (about 1.3 GB,
          mostly PyTorch).
        </div>
      )}
      {error && <p className="tb-bad small">{error}</p>}

      <section className="card tb-step">
        <h2>1. Choose a table</h2>
        <div className="tb-row">
          {info?.samples.map((s) => (
            <button
              key={s.id}
              className="btn small"
              title={s.about}
              disabled={!!busy}
              onClick={() => void load(() => tabularService.sample(s.id))}
            >
              {s.label}
            </button>
          ))}
          <label className="btn small tb-upload">
            Upload a CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void load(() => tabularService.upload(f));
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <p className="small muted">
          The samples are invented by code, so there is nothing private in them. Uploads: up to {info?.limits.upload_mb}{' '}
          MB and {info?.limits.rows.toLocaleString('en-GB')} rows, kept on this machine; TabPFN uses at most{' '}
          {info?.limits.train_rows.toLocaleString('en-GB')} training rows and {info?.limits.columns} columns here.
        </p>
        {table && (
          <>
            <p className="small">
              <b>{table.name}</b>: {table.rows.toLocaleString('en-GB')} rows, {table.columns.length} columns
            </p>
            <div className="table-wrap tb-preview">
              <table className="t">
                <thead>
                  <tr>
                    {table.columns.map((c) => (
                      <th key={c.name} className={c.name === target ? 'tb-target' : ''}>
                        {c.name}
                        <div className="tb-type">
                          {c.type} · {c.distinct} values
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.preview.slice(1).map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className={table.columns[j]?.name === target ? 'tb-target' : ''}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {table && (
        <section className="card tb-step">
          <h2>2. What to predict</h2>
          <div className="tb-row">
            <label className="small">
              Model{' '}
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!busy}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn small" disabled={!!busy} onClick={() => void suggest()}>
              ✨ Suggest a target
            </button>
            <span className="small muted">It sees the column summary only, never the rows.</span>
          </div>
          {why && (
            <p className="small tb-why">
              The model suggests {why && <b>{target}</b>}: {why}
            </p>
          )}
          <div className="tb-row">
            <label className="small">
              Target{' '}
              <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!busy}>
                <option value="">Choose a column</option>
                {table.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="small">
              Task{' '}
              <select value={task} onChange={(e) => setTask(e.target.value as TabularTask)} disabled={!!busy}>
                <option value="classification">Classification (a category)</option>
                <option value="regression">Regression (a quantity)</option>
              </select>
            </label>
            <button className="btn primary" disabled={!!busy || !target || !info?.ready} onClick={() => void run()}>
              Run both models
            </button>
          </div>
          {col?.note && (
            <p className="small tb-bad">
              {col.name}: {col.note}. Choose another target.
            </p>
          )}
        </section>
      )}

      {(busy || steps.length > 0) && (
        <section className="card tb-step" aria-live="polite">
          {busy && (
            <p className="small">
              <span className="tb-pulse" /> {busy}
            </p>
          )}
          <ol className="tb-log small">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      {result && (
        <section className="card tb-step">
          <h2>3. How they compare</h2>
          <p className="small muted">
            {result.train_rows.toLocaleString('en-GB')} training rows, {result.test_rows.toLocaleString('en-GB')} test
            rows, {result.columns} columns used
            {result.dropped_columns.length > 0 && ` (left out: ${result.dropped_columns.join(', ')})`}. TabPFN{' '}
            {result.versions.tabpfn} with {result.versions.weights} weights, on the CPU.
          </p>
          <div className="tb-grid">
            <div>
              {METRICS[result.task].map((m) => (
                <Bars key={m.key} result={result} metric={m} />
              ))}
            </div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th />
                    <th>Fit</th>
                    <th>Predict</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(NAMES) as ModelKey[]).map((k) => (
                    <tr key={k}>
                      <td>{NAMES[k]}</td>
                      <td className="mono">{result.results[k].fit_s} s</td>
                      <td className="mono">{result.results[k].predict_s} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">
                TabPFN’s “fit” only stores the rows; its work happens when it predicts. The trees do the opposite.
              </p>
            </div>
          </div>
          {result.task === 'regression' ? (
            <Scatter result={result} />
          ) : (
            <div className="tb-grid">
              {(Object.keys(NAMES) as ModelKey[]).map((k) => (
                <Confusion key={k} name={NAMES[k]} r={result.results[k]} />
              ))}
            </div>
          )}
          {explanation && (
            <div className="tb-explain">
              <h3>What it means</h3>
              <p>{explanation}</p>
            </div>
          )}
          <p className="small muted">
            Model calls on this page: {usd(cost)}. Both prediction models run free on this machine.
          </p>
        </section>
      )}

      <h2>What a tabular foundation model is</h2>
      <ul className="tb-facts">
        <li>
          <b>Pre-trained on invented tables.</b> TabPFN learnt from millions of synthetic datasets drawn from random
          cause-and-effect structures, so it has seen many kinds of relationship between columns.
        </li>
        <li>
          <b>In-context learning.</b> It reads your training rows as its input and predicts the test rows in one pass,
          the way a language model answers from examples in its prompt. Nothing is trained on your data.
        </li>
        <li>
          <b>Where it does well.</b> Small and medium tables (up to a few thousand rows), where trees have little to
          learn from. It also gives calibrated probabilities without tuning.
        </li>
        <li>
          <b>Its limits.</b> Row and column caps (here 3,000 training rows and 100 columns on a CPU), at most 10
          classes, and prediction is much slower than trees, because all the work happens at prediction time. On large
          tables, tuned gradient boosting is still hard to beat.
        </li>
        <li>
          <b>One split is one sample.</b> With a few hundred test rows, results move a little from split to split.
          Compare several splits before trusting a small gap.
        </li>
      </ul>

      <h2>Who does what</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Read the CSV, check its size, infer the column types</td>
              <td>Code</td>
              <td>A file has to be checked before anything trusts it</td>
            </tr>
            <tr>
              <td>Suggest what to predict, and whether it is a category or a quantity</td>
              <td>The model (Claude, GPT or the local model), from the column summary only</td>
              <td>
                Reading column names for meaning is a language job; code checks the column exists and fits the task
              </td>
            </tr>
            <tr>
              <td>Predict</td>
              <td>TabPFN and gradient boosting, on this machine</td>
              <td>Numbers from tables need models built for tables</td>
            </tr>
            <tr>
              <td>Score both models</td>
              <td>Code (scikit-learn metrics)</td>
              <td>The same predictions always give the same score</td>
            </tr>
            <tr>
              <td>Explain the result in words</td>
              <td>The model; code checks every number it writes is in the results (one retry)</td>
              <td>A language model must not invent a metric</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        TabPFN v2 by Prior Labs (Hollmann et al., Nature, 2025), weights under the Prior Labs License 1.1. Built with
        TabPFN.
      </p>
    </main>
  );
}
