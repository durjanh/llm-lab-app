import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractionService,
  type BatchPoll,
  type BatchSubmitted,
  type Comparison,
  type ConfidenceAnalysis,
  type ExtractionDoc,
  type ExtractionInfo,
  type Issue,
  type RunEvent,
  type SchemaDemo,
  type Summary,
  type ToolChoiceDemo,
  type ValidateDemo,
} from '@/services/extractionService';
import { statusService } from '@/services/statusService';
import './extraction.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const show = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));
const TYPE_NAME: Record<string, string> = { invoice: 'Invoice', receipt: 'Receipt', purchase_order: 'Purchase order' };

interface SessionRun {
  run_id: string;
  model: string;
  few_shot: boolean;
  summary: Summary;
  label: string;
}

function Bar({ value, tone }: { value: number | null | undefined; tone?: 'good' | 'bad' | 'warn' }) {
  const v = value ?? 0;
  const t = tone ?? (v >= 0.9 ? 'good' : v >= 0.75 ? 'warn' : 'bad');
  return (
    <span className="ex-bar" title={pct(value)}>
      <i className={t} style={{ width: `${Math.round(v * 100)}%` }} />
    </span>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const tone = verdict === 'invented' || verdict === 'placeholder' || verdict === 'wrong' ? 'bad' : 'good';
  return <span className={`ex-tag ${tone}`}>{verdict}</span>;
}

function IssueList({ issues, empty }: { issues: Issue[]; empty: string }) {
  if (!issues.length) return <p className="small ex-good">{empty}</p>;
  return (
    <ul className="small ex-issues">
      {issues.map((i, n) => (
        <li key={n}>
          <span className="ex-tag warn">{i.kind}</span> {i.message}
          {i.why && <em className="muted"> {i.why}</em>}
        </li>
      ))}
    </ul>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="ex-json">{JSON.stringify(value, null, 2)}</pre>;
}

/** Accuracy by field and by type, one column per run. */
function AccuracyTable({ runs }: { runs: { label: string; summary: Summary }[] }) {
  const fields = Object.keys(runs[0].summary.by_field);
  const types = Object.keys(runs[0].summary.by_type);
  const rows: [string, (s: Summary) => number | undefined][] = [
    ['Overall', (s) => s.overall],
    ...types.map((t): [string, (s: Summary) => number | undefined] => [
      TYPE_NAME[t] ?? t,
      (s) => s.by_type[t]?.accuracy,
    ]),
    ...fields.map((f): [string, (s: Summary) => number | undefined] => [f, (s) => s.by_field[f]?.accuracy]),
  ];
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th />
            {runs.map((r) => (
              <th key={r.label}>{r.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, get], i) => (
            <tr key={name} className={i === 0 ? 'ex-total' : i === 1 + types.length ? 'ex-gap' : ''}>
              <td>{i > 0 && i <= types.length ? `type: ${name}` : i > types.length ? `field: ${name}` : name}</td>
              {runs.map((r) => (
                <td key={r.label}>
                  <Bar value={get(r.summary)} /> {pct(get(r.summary))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeakSpots({ summary }: { summary: Summary }) {
  if (!summary.weak_spots.length)
    return <p className="small muted">No field or type is more than eight points below the overall figure.</p>;
  return (
    <p className="small ex-notice">
      Overall accuracy is <b>{pct(summary.overall)}</b>, but{' '}
      {summary.weak_spots.map((w, i) => (
        <span key={w.name}>
          {i > 0 && ', '}
          {w.kind} <b>{w.name}</b> is at {pct(w.accuracy)}
        </span>
      ))}
      . One overall figure hides weak spots, so always break it down.
    </p>
  );
}

/** Structured extraction: Scenario 6 of the Claude Certified Architect exam, each mechanism run on one labelled set. */
export default function ExtractionPage() {
  const [info, setInfo] = useState<ExtractionInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [available, setAvailable] = useState<string | null>(null);
  const [docId, setDocId] = useState('rec-04');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [spent, setSpent] = useState(0);

  const [schema, setSchema] = useState<SchemaDemo | null>(null);
  const [choice, setChoice] = useState<ToolChoiceDemo | null>(null);
  const [validation, setValidation] = useState<ValidateDemo | null>(null);
  const [simulate, setSimulate] = useState(true);

  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [progress, setProgress] = useState<{ index: number; of: number; spent: number; label: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [runModel, setRunModel] = useState('');
  const [fewShot, setFewShot] = useState(false);

  const [target, setTarget] = useState(0.95);
  const [seed, setSeed] = useState(7);
  const [analysisRun, setAnalysisRun] = useState('');
  const [analysis, setAnalysis] = useState<ConfidenceAnalysis | null>(null);
  const [runA, setRunA] = useState('');
  const [runB, setRunB] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const [batchModel, setBatchModel] = useState('');
  const [batch, setBatch] = useState<BatchSubmitted | null>(null);
  const [polls, setPolls] = useState<BatchPoll[]>([]);
  const [batchId, setBatchId] = useState('');

  useEffect(() => {
    extractionService
      .info()
      .then(setInfo)
      .catch((e) => setErr(errorText(e)));
    statusService
      .status()
      .then((s) => {
        const list = s.claude_models || s.models || [];
        setModels(list);
        const first = s.claude_model || list[0] || '';
        setModel(first);
        setRunModel(first);
        setBatchModel(first);
        if (!s.available || !s.has_credentials) setAvailable(s.reason || 'The backend has no credentials.');
      })
      .catch(() => undefined);
    return () => abort.current?.abort();
  }, []);

  const doc: ExtractionDoc | undefined = info?.documents.find((d) => d.id === docId);

  const act = async <T,>(name: string, work: () => Promise<T>, done: (r: T) => void) => {
    setBusy(name);
    setErr('');
    try {
      done(await work());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy('');
    }
  };

  // ----- runs over the whole set -----
  const runSet = useCallback(async (m: string, shots: boolean): Promise<SessionRun | null> => {
    const label = `${m.replace('claude-', '')}, ${shots ? '3 examples' : '0 examples'}`;
    const ctl = new AbortController();
    abort.current = ctl;
    let finished: SessionRun | null = null;
    setProgress({ index: 0, of: 24, spent: 0, label });
    await extractionService.run(
      m,
      shots,
      (e: RunEvent) => {
        if (e.type === 'doc') setProgress({ index: e.index, of: e.of, spent: e.spent_usd, label });
        if (e.type === 'error') setErr(e.message);
        if (e.type === 'done') {
          setSpent((s) => s + e.cost_usd);
          finished = { run_id: e.run_id, model: e.model, few_shot: e.few_shot, summary: e.summary, label };
          setRuns((r) => [...r, finished as SessionRun]);
        }
      },
      ctl.signal,
    );
    setProgress(null);
    return finished;
  }, []);

  const startRuns = (name: string, plan: [string, boolean][]) =>
    act(
      name,
      async () => {
        const out: SessionRun[] = [];
        for (const [m, s] of plan) {
          const r = await runSet(m, s);
          if (r) out.push(r);
        }
        return out;
      },
      (out) => {
        if (out.length) {
          setAnalysisRun(out[out.length - 1].run_id);
          setRunA(out[0].run_id);
          setRunB(out[out.length - 1].run_id);
        }
      },
    ).finally(() => setProgress(null));

  const latest = (m: string, shots: boolean) => [...runs].reverse().find((r) => r.model === m && r.few_shot === shots);
  const zero = latest(runModel, false);
  const three = latest(runModel, true);

  // ----- batches -----
  useEffect(() => {
    if (!batchId) return;
    const last = polls[polls.length - 1];
    if (last?.batch_id === batchId && last.ended) return;
    const timer = window.setTimeout(() => {
      extractionService
        .batchPoll(batchId)
        .then((p) => {
          setPolls((l) => [...l.filter((x) => x.batch_id !== p.batch_id), p]);
          if (p.ended) setSpent((s) => s + (p.this_batch?.cost_usd ?? 0));
        })
        .catch((e) => setErr(errorText(e)));
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [batchId, polls]);

  const currentPoll = polls.find((p) => p.batch_id === batchId);
  const group = [...polls].reverse().find((p) => p.group)?.group;

  if (!info)
    return (
      <main className="page-extraction">
        {err ? <p className="ex-bad">{err}</p> : <p className="muted">Loading…</p>}
      </main>
    );

  const modelSelect = (value: string, set: (v: string) => void, disabled = false) => (
    <select value={value} onChange={(e) => set(e.target.value)} disabled={disabled || !!busy}>
      {models.map((m) => (
        <option key={m}>{m}</option>
      ))}
    </select>
  );
  const docOptions = info.documents.map((d) => (
    <option key={d.id} value={d.id}>
      {d.id}: {d.layout}
    </option>
  ));
  const price = (m: string) => info.prices[m];

  return (
    <main className="page-extraction">
      <div className="kicker">Exam practice · Scenario 6 · Structured extraction</div>
      <h1>Structured extraction</h1>
      <p className="lede">
        Turn invoices, till receipts and purchase orders into records a downstream system can trust. Each mechanism
        below runs for real on one invented set of 24 labelled documents, so every claim is measured against a known
        answer.
      </p>
      <nav className="ex-nav small">
        {[
          ['documents', 'Documents'],
          ['schema', '1 Schema'],
          ['tool-choice', '2 tool_choice'],
          ['validation', '3 Validation'],
          ['runs', 'Run the set'],
          ['few-shot', '4 Few-shot'],
          ['batch', '5 Batch'],
          ['confidence', '6 Confidence'],
          ['compare', '7 Compare'],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      {available && <p className="ex-notice small">{available}</p>}
      {err && <p className="ex-bad small">{err}</p>}
      <p className="small muted ex-spent">Spent on this page this visit: {usd(spent)}</p>

      <section className="card" id="documents">
        <h2>The documents</h2>
        <p className="small">
          Three types in deliberately different layouts: tables, prose, inline amounts, informal measures, missing
          fields, lines that do not add up, and two whose payment terms live in a contract that is not provided. Each
          has ground truth for every field, and a split: the <b>validation</b> half is for choosing settings, the{' '}
          <b>test</b> half checks them.
        </p>
        <label className="small">
          Document used by sections 1 to 3:{' '}
          <select value={docId} onChange={(e) => setDocId(e.target.value)}>
            {docOptions}
          </select>
        </label>
        {doc && (
          <div className="ex-doc">
            <div>
              <p className="small">
                <b>{TYPE_NAME[doc.type]}</b>, {doc.split} split. {doc.note}
              </p>
              <pre className="ex-text">{doc.text}</pre>
            </div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Ground truth</th>
                  </tr>
                </thead>
                <tbody>
                  {info.fields.map((f) => (
                    <tr key={f}>
                      <td>{f}</td>
                      <td className={doc.truth[f] === null ? 'muted' : ''}>{show(doc.truth[f])}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>lines add up?</td>
                    <td>{doc.conflict ? 'no (a real conflict)' : 'yes'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
        <details>
          <summary className="small">All 24 documents</summary>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Type</th>
                  <th>Split</th>
                  <th>Layout</th>
                </tr>
              </thead>
              <tbody>
                {info.documents.map((d) => (
                  <tr key={d.id} onClick={() => setDocId(d.id)} className="ex-click">
                    <td>{d.id}</td>
                    <td>{TYPE_NAME[d.type]}</td>
                    <td>{d.split}</td>
                    <td>{d.layout}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <p className="small muted">
          Model for sections 1 to 3: {modelSelect(model, setModel)}. Costs are shown after each run; prices per million
          tokens for {model}: {price(model) ? `${usd(price(model).input)} in, ${usd(price(model).output)} out` : '–'}.
        </p>
      </section>

      <section className="card" id="schema">
        <h2>1. Extraction as a tool with a schema</h2>
        <p className="small">
          The model is given a tool and told to call it, so the answer arrives as JSON that matches a schema, not as
          free text to be parsed. The schema design matters. A field that is <b>required and cannot be null</b> leaves
          the model no honest answer when a document lacks that value, so it invents one. A <b>nullable</b> field lets
          it say “absent”. The schema also has an <code>other</code> category with a detail string, and{' '}
          <code>unclear</code> for values the document leaves ambiguous. Optional fields (<code>category_detail</code>)
          are left out of <code>required</code>.
        </p>
        <p className="small muted">Pick a document that lacks fields: rec-04 has no date, number or VAT number.</p>
        <button
          className="btn primary"
          disabled={!!busy || !!available}
          onClick={() =>
            act(
              'schema',
              () => extractionService.schema(docId, model),
              (r) => (setSchema(r), setSpent((s) => s + r.cost_usd)),
            )
          }
        >
          {busy === 'schema' ? 'Running both…' : `Run both schemas on ${docId}`}
        </button>
        {schema && (
          <>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Truth</th>
                    <th>Required, not nullable</th>
                    <th>Nullable</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(schema.variants.required.fields).map((f) => (
                    <tr key={f}>
                      <td>{f}</td>
                      <td className={schema.variants.nullable.fields[f]?.truth === null ? 'muted' : ''}>
                        {show(schema.variants.nullable.fields[f]?.truth)}
                      </td>
                      {(['required', 'nullable'] as const).map((v) => (
                        <td key={v}>
                          {show(schema.variants[v].fields[f]?.got)}{' '}
                          {schema.absent_fields.includes(f) && (
                            <Verdict verdict={schema.variants[v].fields[f].verdict} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small ex-notice">
              Missing from the document: {schema.absent_fields.join(', ') || 'nothing'}. Required schema invented or
              padded: <b>{schema.invented.required.join(', ') || 'nothing this time'}</b>. Nullable schema:{' '}
              <b>{schema.invented.nullable.join(', ') || 'nothing'}</b>. Cost {usd(schema.cost_usd)}.
            </p>
          </>
        )}
        <details>
          <summary className="small">The two schemas</summary>
          <div className="ex-two">
            <div>
              <h3>Nullable (used everywhere else)</h3>
              <Json value={info.schemas.nullable} />
            </div>
            <div>
              <h3>Required, not nullable</h3>
              <Json value={info.schemas.required} />
            </div>
          </div>
        </details>
      </section>

      <section className="card" id="tool-choice">
        <h2>2. tool_choice on one document</h2>
        <p className="small">
          <code>auto</code> lets the model answer in text. <code>any</code> forces some tool call, and with two
          extraction tools (invoice, receipt) the model picks the one that fits. A forced{' '}
          <code>{'{"type":"tool","name":"extract_metadata"}'}</code> makes one named tool run first, whatever else is on
          offer, so a metadata step is guaranteed before enrichment. The last step shows the pattern: code reads the
          metadata and forces the right full extraction tool.
        </p>
        <button
          className="btn primary"
          disabled={!!busy || !!available}
          onClick={() =>
            act(
              'choice',
              () => extractionService.toolChoice(docId, model),
              (r) => (setChoice(r), setSpent((s) => s + r.cost_usd)),
            )
          }
        >
          {busy === 'choice' ? 'Running four calls…' : `Run auto, any, forced and enrichment on ${docId}`}
        </button>
        {choice && (
          <div className="ex-grid">
            {choice.steps.map((s) => (
              <div key={s.mode} className="ex-step">
                <h3>{s.mode}</h3>
                <p className="small muted">{s.note}</p>
                <p className="small">
                  tool_choice <code>{JSON.stringify(s.tool_choice)}</code>
                  <br />
                  tools offered: {s.tools.join(', ')}
                </p>
                <p className="small">
                  stop_reason <b>{s.response.stop_reason}</b> · {s.response.usage.input_tokens} in /{' '}
                  {s.response.usage.output_tokens} out · {s.latency_s}s · {usd(s.cost_usd)}
                </p>
                <Json value={s.response.content} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card" id="validation">
        <h2>3. Validation and retry</h2>
        <p className="small">
          The schema guarantees shape, not sense. Code checks what it cannot: dates parse, amounts are numbers, the line
          items add up to the total, the currency is one we post. When a check fails and the model could fix it, a
          follow-up request carries the document, the failed extraction and the specific errors. When the information is
          simply not in the document, a retry only tempts the model to invent it, so the loop stops and flags the
          document for a person. The schema has <code>calculated_total</code> next to <code>stated_total</code> and a{' '}
          <code>conflict_detected</code> flag, so a document that does not add up is reported, not quietly corrected.
        </p>
        <div className="ex-row small">
          <label>
            <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} /> Simulate sloppy
            output on the first attempt (the lab rewrites the date and total, to show the fix)
          </label>
        </div>
        <div className="ex-row small">
          Try:{' '}
          <button className="btn" onClick={() => setDocId('inv-01')}>
            inv-01 (a format error)
          </button>
          <button className="btn" onClick={() => setDocId('inv-05')}>
            inv-05 (terms in an attached contract)
          </button>
          <button className="btn" onClick={() => setDocId('inv-08')}>
            inv-08 (bare $)
          </button>
          <button className="btn" onClick={() => setDocId('inv-04')}>
            inv-04 (lines do not sum)
          </button>
        </div>
        <button
          className="btn primary"
          disabled={!!busy || !!available}
          onClick={() =>
            act(
              'validate',
              () => extractionService.validate(docId, model, simulate),
              (r) => (setValidation(r), setSpent((s) => s + r.cost_usd)),
            )
          }
        >
          {busy === 'validate' ? 'Extracting…' : `Extract, validate and retry ${docId}`}
        </button>
        {validation && (
          <div className="ex-attempts">
            {validation.attempts.map((a) => (
              <div key={a.attempt} className="ex-step">
                <h3>Attempt {a.attempt}</h3>
                {a.simulated && <p className="small muted">{a.simulated}</p>}
                <IssueList issues={a.issues} empty="Every check passed." />
                <p className="small">
                  Decision: <b>{a.decision.action}</b>. {a.decision.reason}
                </p>
                <details>
                  <summary className="small">{a.attempt > 1 ? 'The follow-up request' : 'The request'}</summary>
                  <pre className="ex-text">{a.request}</pre>
                </details>
                <details>
                  <summary className="small">The extraction that was checked</summary>
                  <Json value={a.extraction} />
                </details>
              </div>
            ))}
            <p className={`small ex-notice ${validation.status}`}>
              <b>{validation.status === 'accepted' ? 'Accepted.' : 'Flagged for a person.'}</b> {validation.reason}{' '}
              {validation.status === 'flagged' && validation.left_for_review.length > 0 && (
                <>Left for review: {validation.left_for_review.map((i) => i.field).join(', ')}.</>
              )}{' '}
              {validation.attempts.length} model call{validation.attempts.length === 1 ? '' : 's'},{' '}
              {usd(validation.cost_usd)}.
            </p>
          </div>
        )}
      </section>

      <section className="card" id="runs">
        <h2>Run the whole set</h2>
        <p className="small">
          Sections 4, 6 and 7 work from full runs over all 24 documents (four at a time, streamed as each finishes).
          Each document goes through the forced <code>extract_document</code> tool, the checks and the scoring. A run is
          kept here so later sections can analyse it without paying again.
        </p>
        <div className="ex-row small">
          <label>Model {modelSelect(runModel, setRunModel)}</label>
          <label>
            <select value={fewShot ? '3' : '0'} onChange={(e) => setFewShot(e.target.value === '3')} disabled={!!busy}>
              <option value="0">0 examples</option>
              <option value="3">3 examples</option>
            </select>
          </label>
          <button
            className="btn primary"
            disabled={!!busy || !!available}
            onClick={() => startRuns('run', [[runModel, fewShot]])}
          >
            Run 24 documents
          </button>
          {price(runModel) && (
            <span className="muted">
              About {usd((24 * (1100 * price(runModel).input + 450 * price(runModel).output)) / 1e6)} at list price
            </span>
          )}
        </div>
        {progress && (
          <div className="ex-progress small">
            <progress value={progress.index} max={progress.of} /> {progress.label}: {progress.index} of {progress.of},{' '}
            {usd(progress.spent)}
            <button className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          </div>
        )}
        {runs.length > 0 && (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Accuracy</th>
                  <th>Empty required</th>
                  <th>Latency</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id}>
                    <td>{r.label}</td>
                    <td>{pct(r.summary.overall)}</td>
                    <td>{r.summary.empties}</td>
                    <td>{r.summary.latency_mean_s}s</td>
                    <td>{usd(r.summary.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" id="few-shot">
        <h2>4. Few-shot examples for varied layouts</h2>
        <p className="small">
          Documents differ in layout, and a rule written for tables does not obviously cover prose. Three worked
          examples in the system prompt (a table with a discount, a vague prose receipt with no date, an order that
          defers to a contract) show the model what “absent” and “unclear” look like. The examples are not in the set,
          so they cannot leak the answers. “Empty” counts required fields where the truth has a value and the model
          returned null, a placeholder or “unclear”.
        </p>
        <button
          className="btn primary"
          disabled={!!busy || !!available}
          onClick={() =>
            startRuns('shots', [
              ...(zero ? [] : ([[runModel, false]] as [string, boolean][])),
              ...(three ? [] : ([[runModel, true]] as [string, boolean][])),
            ])
          }
        >
          {zero && three
            ? 'Both runs done for this model'
            : `Run ${runModel.replace('claude-', '')} with 0 and 3 examples`}
        </button>
        {zero && three && (
          <>
            <div className="ex-cards">
              {[zero, three].map((r) => (
                <div key={r.run_id} className="ex-card">
                  <h3>{r.few_shot ? '3 examples' : '0 examples'}</h3>
                  <p className="ex-big">{pct(r.summary.overall)}</p>
                  <p className="small">
                    {r.summary.empties} empty required field{r.summary.empties === 1 ? '' : 's'} ·{' '}
                    {r.summary.docs_perfect} of {r.summary.docs} documents perfect · {usd(r.summary.cost_usd)}
                  </p>
                </div>
              ))}
            </div>
            <AccuracyTable
              runs={[zero, three].map((r) => ({ label: r.few_shot ? '3 examples' : '0 examples', summary: r.summary }))}
            />
            <p className="small muted">
              Examples cost tokens on every call (compare the cost column), so keep only those that fix a measured
              failure. With a strong model the gain may be small; the measurement is the point.
            </p>
          </>
        )}
      </section>

      <section className="card" id="batch">
        <h2>5. Batch processing</h2>
        <p className="small">
          The Message Batches API takes a list of requests, each with a <code>custom_id</code>, and returns the results
          later, in any order. It costs <b>half the price</b>, finishes within 24 hours (usually much sooner), and a
          request inside it cannot run a multi-turn tool loop, because nothing can answer a tool call mid-batch. That
          fits overnight or backlog work that can wait. A check that blocks someone (an invoice approval screen) needs
          the synchronous API. Results are matched by <code>custom_id</code>, and only the failures are sent again.
        </p>
        <p className="small">
          This first pass uses a deliberately small output limit ({info.first_pass_tokens} tokens), so the 30-line order
          po-07 will be cut off. Resubmitting splits it into chunks, which the page then merges back. This sends a real
          batch: most finish within a few minutes, and the page checks every few seconds.
        </p>
        <div className="ex-row small">
          <label>Model {modelSelect(batchModel, setBatchModel)}</label>
          <button
            className="btn primary"
            disabled={!!busy || !!available}
            onClick={() =>
              act(
                'batch',
                () => extractionService.batchSubmit(batchModel),
                (b) => {
                  setBatch(b);
                  setPolls([]);
                  setBatchId(b.batch_id);
                },
              )
            }
          >
            Submit the 24 documents as a batch
          </button>
        </div>
        {batch && (
          <>
            <p className="small">
              Submitted <b>{batch.batch_id}</b> with {batch.requests} requests; expires {batch.expires_at}.
            </p>
            <details>
              <summary className="small">The first request in the batch</summary>
              <Json value={batch.first_request} />
            </details>
          </>
        )}
        {polls.map((p) => (
          <div key={p.batch_id} className="ex-step">
            <h3>
              Round {p.round}: {p.batch_id}
            </h3>
            <p className="small">
              {p.status}:{' '}
              {Object.entries(p.counts)
                .map(([k, v]) => `${v} ${k}`)
                .join(', ')}
              {!p.ended && p.batch_id === batchId && ' (checking again shortly)'}
            </p>
            {p.this_batch && (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>custom_id</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.custom_ids.map((c) => {
                      const o = p.this_batch!.outcomes[c];
                      return (
                        <tr key={c}>
                          <td>{c}</td>
                          <td className={o?.status === 'ok' ? 'ex-good' : 'ex-bad'}>
                            {o?.status === 'ok' ? 'extracted' : `${o?.reason}: ${o?.detail}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {currentPoll?.ended && group && (
          <>
            <p className="small ex-notice">
              {group.ok} of {group.docs} documents extracted
              {group.summary && <>, accuracy {pct(group.summary.overall)}</>}. Batch cost {usd(group.cost_usd)} against{' '}
              {usd(group.standard_usd)} for the same requests sent one at a time.
            </p>
            {group.plan.resubmit.length > 0 && (
              <>
                <p className="small">To send again:</p>
                <ul className="small">
                  {group.plan.resubmit.map((r) => (
                    <li key={r.doc_id}>
                      <b>{r.doc_id}</b>: {r.reason}, so{' '}
                      {r.action === 'chunk' ? 'split into chunks with a larger limit' : 'send unchanged'}
                    </li>
                  ))}
                </ul>
                <button
                  className="btn primary"
                  disabled={!!busy}
                  onClick={() =>
                    act(
                      'resubmit',
                      () => extractionService.batchResubmit(currentPoll.batch_id),
                      (r) => {
                        setBatchId(r.batch_id);
                      },
                    )
                  }
                >
                  Resubmit only these {group.plan.resubmit.length}
                </button>
              </>
            )}
            {group.plan.held.length > 0 && (
              <p className="small muted">
                Held back, because sending them again unchanged would fail the same way:{' '}
                {group.plan.held.map((h) => `${h.doc_id} (${h.reason})`).join(', ')}.
              </p>
            )}
            {group.summary && <WeakSpots summary={group.summary} />}
          </>
        )}
      </section>

      <section className="card" id="confidence">
        <h2>6. Human review and calibration</h2>
        <p className="small">
          The model gives a confidence for every field. Models tend to be sure of themselves, so the number is only
          useful once it is compared with the truth. On the <b>validation</b> split, accuracy per confidence band shows
          how far to trust it, and the lowest confidence at which accuracy reaches the target becomes the review
          threshold. The <b>test</b> split then shows whether that threshold holds on documents it was not chosen on. A
          seeded stratified sample of auto-accepted documents (the same number of each type) is drawn for spot checks,
          so quiet failures are still found.
        </p>
        {runs.length === 0 ? (
          <p className="small muted">Run the whole set first (above).</p>
        ) : (
          <>
            <div className="ex-row small">
              <label>
                Run{' '}
                <select value={analysisRun} onChange={(e) => setAnalysisRun(e.target.value)}>
                  {runs.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target accuracy{' '}
                <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                  {[0.9, 0.95, 0.98].map((t) => (
                    <option key={t} value={t}>
                      {pct(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Seed{' '}
                <input
                  type="number"
                  value={seed}
                  min={0}
                  max={1000000}
                  onChange={(e) => setSeed(Number(e.target.value))}
                />
              </label>
              <button
                className="btn primary"
                disabled={!!busy}
                onClick={() =>
                  act(
                    'conf',
                    () => extractionService.confidence(analysisRun || runs[runs.length - 1].run_id, target, seed, 2),
                    setAnalysis,
                  )
                }
              >
                Analyse (free)
              </button>
            </div>
            {analysis && (
              <>
                <h3>Calibration on the validation split ({analysis.validation_docs} documents)</h3>
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Confidence band</th>
                        <th>Fields</th>
                        <th>Mean confidence</th>
                        <th>Actual accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.calibration.map((b) => (
                        <tr key={b.band}>
                          <td>{b.band}</td>
                          <td>{b.n}</td>
                          <td>{b.mean_confidence === null ? '–' : pct(b.mean_confidence)}</td>
                          <td>
                            <Bar value={b.accuracy} /> {pct(b.accuracy)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small ex-notice">
                  {analysis.threshold.reached ? (
                    <>
                      Review threshold <b>{analysis.threshold.threshold.toFixed(2)}</b>: above it, validation accuracy
                      is {pct(analysis.threshold.accuracy_above)} on {pct(analysis.threshold.coverage)} of fields. On
                      the test split, <b>{analysis.test.auto}</b> documents are auto-accepted at{' '}
                      <b>{pct(analysis.test.auto_accuracy)}</b> field accuracy, and <b>{analysis.test.review}</b> go to
                      a person. Accuracy of all test documents, with no routing: {pct(analysis.test.all_accuracy)}.
                    </>
                  ) : (
                    <>
                      No confidence level reaches {pct(analysis.target)} on the validation split, so everything goes to
                      a person. That is a finding too: the confidence cannot be used as a gate for this model.
                    </>
                  )}
                </p>
                <h3>Accuracy by type and field (all 24 documents)</h3>
                <AccuracyTable
                  runs={[
                    {
                      label: runs.find((r) => r.run_id === analysis.run_id)?.label ?? 'run',
                      summary: analysis.overall,
                    },
                  ]}
                />
                <WeakSpots summary={analysis.overall} />
                <h3>Spot-check sample (seed {analysis.seed}, two per type, from the auto-accepted)</h3>
                {analysis.spot_check.length ? (
                  <ul className="small">
                    {analysis.spot_check.map((s) => (
                      <li key={s.doc_id}>
                        <b>{s.doc_id}</b> ({TYPE_NAME[s.type]}), lowest field confidence {s.confidence_min?.toFixed(2)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">
                    Nothing was auto-accepted on the test split, so there is nothing to sample.
                  </p>
                )}
                <details>
                  <summary className="small">Routing of each test document</summary>
                  <ul className="small">
                    {analysis.test.routing.map((r) => (
                      <li key={r.doc_id}>
                        <b>{r.doc_id}</b>: {r.review ? `review (${r.reasons.slice(0, 3).join('; ')})` : 'auto-accept'}
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
          </>
        )}
      </section>

      <section className="card" id="compare">
        <h2>7. Compare two models</h2>
        <p className="small">
          Before moving to a new model release, run both on the same labelled set and compare accuracy per field and
          type, latency and cost. Behaviour can change between releases in ways no release note lists: a field that was
          reliable may regress while the overall figure holds. The regressions list names each field that A got right
          and B got wrong. Whether the extra cost buys enough accuracy is a cost-performance decision, per type and
          field, not one number.
        </p>
        <button
          className="btn"
          disabled={!!busy || !!available || models.length < 2}
          onClick={() =>
            startRuns(
              'ab',
              models
                .slice(0, 2)
                .filter((m) => !latest(m, false))
                .map((m) => [m, false] as [string, boolean]),
            )
          }
        >
          Run the first two models (
          {models
            .slice(0, 2)
            .map((m) => m.replace('claude-', ''))
            .join(' and ')}
          ) with 0 examples
        </button>
        {runs.length >= 2 && (
          <>
            <div className="ex-row small">
              <label>
                A{' '}
                <select value={runA} onChange={(e) => setRunA(e.target.value)}>
                  {runs.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                B{' '}
                <select value={runB} onChange={(e) => setRunB(e.target.value)}>
                  {runs.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn primary"
                disabled={!!busy || !runA || !runB}
                onClick={() => act('compare', () => extractionService.compare(runA, runB), setComparison)}
              >
                Compare (free)
              </button>
            </div>
            {comparison && (
              <>
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th />
                        <th>A: {comparison.a.model.replace('claude-', '')}</th>
                        <th>B: {comparison.b.model.replace('claude-', '')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="ex-total">
                        <td>Overall accuracy</td>
                        <td>{pct(comparison.a.summary.overall)}</td>
                        <td>
                          {pct(comparison.b.summary.overall)} ({comparison.overall_delta >= 0 ? '+' : ''}
                          {Math.round(comparison.overall_delta * 100)} points)
                        </td>
                      </tr>
                      {Object.entries(comparison.by_type).map(([k, v]) => (
                        <tr key={k}>
                          <td>type: {TYPE_NAME[k] ?? k}</td>
                          <td>{pct(v.a)}</td>
                          <td className={v.delta < 0 ? 'ex-bad' : ''}>{pct(v.b)}</td>
                        </tr>
                      ))}
                      {Object.entries(comparison.by_field).map(([k, v]) => (
                        <tr key={k}>
                          <td>field: {k}</td>
                          <td>{pct(v.a)}</td>
                          <td className={v.delta < 0 ? 'ex-bad' : ''}>{pct(v.b)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td>Mean latency</td>
                        <td>{comparison.a.summary.latency_mean_s}s</td>
                        <td>{comparison.b.summary.latency_mean_s}s</td>
                      </tr>
                      <tr>
                        <td>Cost per 1,000 documents</td>
                        <td>${comparison.cost_per_1000_docs.a.toFixed(2)}</td>
                        <td>${comparison.cost_per_1000_docs.b.toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td>Cost per correct field</td>
                        <td>{usd(comparison.cost_per_correct_field.a)}</td>
                        <td>{usd(comparison.cost_per_correct_field.b)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <h3>
                  Regressions in B ({comparison.regressions.length}) and improvements ({comparison.improvements.length})
                </h3>
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th />
                        <th>Document</th>
                        <th>Field</th>
                        <th>Truth</th>
                        <th>A</th>
                        <th>B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ...comparison.regressions.map((r) => ['worse', r] as const),
                        ...comparison.improvements.map((r) => ['better', r] as const),
                      ]
                        .slice(0, 30)
                        .map(([kind, r]) => (
                          <tr key={`${kind}${r.doc_id}${r.field}`}>
                            <td className={kind === 'worse' ? 'ex-bad' : 'ex-good'}>{kind}</td>
                            <td>{r.doc_id}</td>
                            <td>{r.field}</td>
                            <td>{show(r.truth)}</td>
                            <td>{show(r.a)}</td>
                            <td>{show(r.b)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section className="takeaways">
        <h2>What to take away</h2>
        <ul>
          <li>
            Extract through a tool with a schema, not free text. Make fields nullable when a document may not have them.
          </li>
          <li>
            <code>tool_choice</code>: auto may answer in text; any must call a tool; a named tool forces one step first.
          </li>
          <li>
            Validate meaning in code, retry with the specific errors, and stop when the information is not in the
            document.
          </li>
          <li>Measure few-shot examples, do not assume them. Break accuracy down by field and type.</li>
          <li>Batch the work that can wait, at half price; keep the synchronous API for blocking checks.</li>
          <li>Calibrate confidence against labelled data before using it to route work, and sample what you accept.</li>
          <li>Compare models on your own labelled set before you switch.</li>
        </ul>
      </section>
    </main>
  );
}
