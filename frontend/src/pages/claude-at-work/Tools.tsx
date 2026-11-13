import { useEffect, useState, type ReactNode } from 'react';
import { atWorkService as svc } from '@/services/atWorkService';
import type {
  Checked,
  ClaimVerdict,
  Decomposed,
  Rewritten,
  TaskRuns,
  TaskType,
  Template,
  UseCaseResult,
} from '@/services/atWorkService';
import { statusService } from '@/services/statusService';
import { AUDIENCE_PRESETS, CHECK_SAMPLES, REWRITE_SOURCE, USE_SAMPLES } from './content';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cost = (c: number) => `$${c.toFixed(4)}`;

/** Runs a paid call, tracking busy, error and result so each tool stays short. */
function useCall<T>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<T | null>(null);
  const run = async (fn: () => Promise<T>) => {
    setBusy(true);
    setError('');
    try {
      setResult(await fn());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, result, run, clear: () => setResult(null) };
}

export function useModels() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => undefined);
  }, []);
  return { models, model, setModel };
}

type Picker = ReturnType<typeof useModels>;

function ModelPick({ p }: { p: Picker }) {
  return (
    <label className="aw-model small muted">
      Model{' '}
      <select value={p.model} onChange={(e) => p.setModel(e.target.value)} disabled={!p.models.length}>
        {p.models.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
    </label>
  );
}

function Status({ busy, error, spent }: { busy: boolean; error: string; spent?: number }) {
  return (
    <>
      {busy && <p className="small muted">Working…</p>}
      {error && <p className="small aw-bad">{error}</p>}
      {spent !== undefined && <p className="small muted">This call cost {cost(spent)}.</p>}
    </>
  );
}

const TYPES: { id: TaskType; label: string }[] = [
  { id: 'analysis', label: 'Analysis' },
  { id: 'research', label: 'Research' },
  { id: 'drafting', label: 'Drafting' },
  { id: 'brainstorming', label: 'Brainstorming' },
];

function TemplateView({ t }: { t: Template }) {
  return (
    <div className="aw-template">
      <h4>{t.label}</h4>
      {Object.entries(t.sections).map(([name, body]) => (
        <p key={name}>
          <b>{name.replace('_', ' ')}</b>
          <br />
          {body}
        </p>
      ))}
    </div>
  );
}

export function TaskTypes({ p }: { p: Picker }) {
  const [goal, setGoal] = useState('Work out why customer complaints rose in October and what to do about it.');
  const [context, setContext] = useState('');
  const [first, setFirst] = useState<TaskType>('analysis');
  const [second, setSecond] = useState<TaskType | ''>('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const runs = useCall<TaskRuns>();
  const steps = useCall<Decomposed>();
  const chosen: TaskType[] = second && second !== first ? [first, second] : [first];

  useEffect(() => {
    const timer = setTimeout(() => {
      Promise.all(chosen.map((t) => svc.template(t, goal.trim() || '[your goal]', context)))
        .then(setTemplates)
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, context, first, second]);

  const ready = goal.trim().length >= 3 && p.model;
  return (
    <div className="card">
      <label className="small">
        Your goal
        <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label className="small">
        Context (optional): facts, numbers or text Claude should use
        <textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} />
      </label>
      <div className="aw-row">
        <label className="small">
          Task type{' '}
          <select value={first} onChange={(e) => setFirst(e.target.value as TaskType)}>
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Compare with{' '}
          <select value={second} onChange={(e) => setSecond(e.target.value as TaskType | '')}>
            <option value="">(nothing)</option>
            {TYPES.filter((t) => t.id !== first).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <ModelPick p={p} />
      </div>
      <p className="small muted">The template for each type is built by code, free, and updates as you type.</p>
      <div className="aw-cols">
        {templates.map((t) => (
          <TemplateView key={t.task_type} t={t} />
        ))}
      </div>
      <div className="aw-row">
        <button
          className="btn primary"
          disabled={!ready || runs.busy}
          onClick={() => runs.run(() => svc.run(goal.trim(), context, chosen, p.model))}
        >
          {chosen.length === 2 ? 'Run both side by side' : 'Run this prompt'}
        </button>
        <button
          className="btn"
          disabled={!ready || goal.trim().length < 10 || steps.busy}
          onClick={() => steps.run(() => svc.decompose(goal.trim(), p.model))}
        >
          Decompose into steps
        </button>
      </div>
      <Status busy={runs.busy || steps.busy} error={runs.error || steps.error} />
      {runs.result && (
        <>
          <div className="aw-cols">
            {runs.result.runs.map((r) => (
              <div key={r.task_type} className="aw-out">
                <h4>{r.label} answer</h4>
                <div className="aw-pre">{r.answer}</div>
              </div>
            ))}
          </div>
          <p className="small muted">
            {runs.result.runs.length === 2
              ? 'Same goal, different approach: compare what each one asks for, how it treats evidence and what it hands back.'
              : 'Try a second task type to see how the approach changes.'}{' '}
            Cost {cost(runs.result.cost_usd)}.
          </p>
        </>
      )}
      {steps.result && (
        <div className="aw-out">
          <h4>Decomposed</h4>
          <p>{steps.result.summary}</p>
          <ol>
            {steps.result.steps.map((s, i) => (
              <li key={i}>
                <b>{s.title}</b>
                {s.depends_on_previous ? ' (uses the last answer)' : ''}
                <br />
                Ask: {s.what_to_ask}
                <br />
                <span className="muted">Check first: {s.check_before_next}</span>
              </li>
            ))}
          </ol>
          <p className="small muted">Cost {cost(steps.result.cost_usd)}.</p>
        </div>
      )}
    </div>
  );
}

export function Audiences({ p }: { p: Picker }) {
  const [source, setSource] = useState(REWRITE_SOURCE);
  const [picked, setPicked] = useState<string[]>(['Executive summary', 'Customer email']);
  const [custom, setCustom] = useState('');
  const call = useCall<Rewritten>();
  const toggle = (a: string) =>
    setPicked((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : cur.length < 3 ? [...cur, a] : cur));
  const addCustom = () => {
    const c = custom.trim();
    if (c.length >= 2 && !picked.some((x) => x.toLowerCase() === c.toLowerCase()) && picked.length < 3) {
      setPicked([...picked, c]);
      setCustom('');
    }
  };
  return (
    <div className="card">
      <label className="small">
        Source answer
        <textarea rows={4} value={source} onChange={(e) => setSource(e.target.value)} />
      </label>
      <p className="small">Pick two or three audiences:</p>
      <div className="aw-row">
        {[...AUDIENCE_PRESETS, ...picked.filter((x) => !AUDIENCE_PRESETS.includes(x))].map((a) => (
          <label key={a} className="small aw-chip">
            <input type="checkbox" checked={picked.includes(a)} onChange={() => toggle(a)} /> {a}
          </label>
        ))}
      </div>
      <div className="aw-row">
        <input
          value={custom}
          placeholder="Another audience"
          maxLength={80}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCustom()}
        />
        <button className="btn" onClick={addCustom}>
          Add
        </button>
        <ModelPick p={p} />
      </div>
      <button
        className="btn primary"
        disabled={picked.length < 2 || source.trim().length < 10 || !p.model || call.busy}
        onClick={() => call.run(() => svc.rewrite(source.trim(), picked, p.model))}
      >
        Rewrite for {picked.length} audiences
      </button>
      <Status busy={call.busy} error={call.error} spent={call.result?.cost_usd} />
      {call.result && (
        <div className="aw-cols">
          {call.result.versions.map((v) => (
            <div key={v.audience} className="aw-out">
              <h4>{v.audience}</h4>
              <div className="aw-pre">{v.text}</div>
              <p className="small">
                <b>What changed:</b> {v.what_changed}
                <br />
                <b>Why:</b> {v.why}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CLAIM_LABEL: Record<ClaimVerdict, string> = {
  supported: 'Supported by the source',
  contradicted: 'Contradicts the source',
  unverifiable: 'Cannot be verified',
};
const REVIEW_LABEL = { send: 'Fine to send', review_first: 'Human review before sending', do_not_send: 'Do not send' };

export function CheckAnswer({ p }: { p: Picker }) {
  const [answer, setAnswer] = useState(CHECK_SAMPLES[0].answer);
  const [source, setSource] = useState(CHECK_SAMPLES[0].source);
  const call = useCall<Checked>();
  const r: Checked | null = call.result;
  return (
    <div className="card">
      <p className="small">
        <b>The model's own confidence is not evidence.</b> A fluent, certain answer can still contain an invented number
        or section. The check below compares claims with the source you give it, and code raises the review level when
        the model finds a problem but says "send".
      </p>
      <div className="aw-row">
        {CHECK_SAMPLES.map((s) => (
          <button
            key={s.name}
            className="btn"
            onClick={() => {
              setAnswer(s.answer);
              setSource(s.source);
              call.clear();
            }}
          >
            Sample: {s.name}
          </button>
        ))}
      </div>
      <div className="aw-cols">
        <label className="small">
          Claude's answer
          <textarea rows={6} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </label>
        <label className="small">
          Source text (optional; without it every claim is unverifiable)
          <textarea rows={6} value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
      </div>
      <div className="aw-row">
        <button
          className="btn primary"
          disabled={answer.trim().length < 10 || !p.model || call.busy}
          onClick={() => call.run(() => svc.check(answer.trim(), source.trim(), p.model))}
        >
          Check this answer
        </button>
        <ModelPick p={p} />
      </div>
      <Status busy={call.busy} error={call.error} spent={r?.cost_usd} />
      {r && (
        <div className="aw-out">
          <p className={`aw-verdict aw-${r.verdict}`}>
            {REVIEW_LABEL[r.verdict]}: {r.verdict_reason}
          </p>
          {r.raised_by_code && <p className="small muted">Code raised this level above what the model first said.</p>}
          <h4>Claims</h4>
          <ul>
            {r.claims.map((c, i) => (
              <li key={i}>
                <span className={`aw-tag aw-${c.verdict}`}>{CLAIM_LABEL[c.verdict]}</span> {c.claim}
                <br />
                <span className="small muted">{c.evidence}</span>
              </li>
            ))}
          </ul>
          <h4>Details that need checking</h4>
          {r.details_to_check.length ? (
            <ul>
              {r.details_to_check.map((d, i) => (
                <li key={i}>
                  <b>{d.detail}</b> ({d.kind.replace('_', ' ')}): {d.why}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None found.</p>
          )}
          <h4>Signs of bias or one-sided framing</h4>
          {r.bias_signs.length ? (
            <ul>
              {r.bias_signs.map((b, i) => (
                <li key={i}>
                  "{b.quote}": {b.concern}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None found.</p>
          )}
        </div>
      )}
    </div>
  );
}

const USE_LABEL = { appropriate: 'Appropriate', needs_care: 'Needs care', not_appropriate: 'Not appropriate' };

export function UseCase({ p }: { p: Picker }) {
  const [task, setTask] = useState(USE_SAMPLES[0].task);
  const [data, setData] = useState(USE_SAMPLES[0].data);
  const call = useCall<UseCaseResult>();
  const r = call.result;
  const out = (n: ReactNode) => <div className="aw-out">{n}</div>;
  return (
    <div className="card">
      <div className="aw-row">
        {USE_SAMPLES.map((s, i) => (
          <button
            key={i}
            className="btn"
            onClick={() => {
              setTask(s.task);
              setData(s.data);
              call.clear();
            }}
          >
            Example {i + 1}
          </button>
        ))}
      </div>
      <label className="small">
        What do you want Claude to do?
        <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} />
      </label>
      <label className="small">
        What data is involved?
        <textarea rows={2} value={data} onChange={(e) => setData(e.target.value)} />
      </label>
      <p className="small muted">
        Use invented details here. The description is sent to the model to be assessed, so do not type real personal
        data.
      </p>
      <div className="aw-row">
        <button
          className="btn primary"
          disabled={task.trim().length < 10 || !p.model || call.busy}
          onClick={() => call.run(() => svc.useCase(task.trim(), data.trim(), p.model))}
        >
          Is this a good use?
        </button>
        <ModelPick p={p} />
      </div>
      <Status busy={call.busy} error={call.error} spent={r?.cost_usd} />
      {r &&
        out(
          <>
            <p className={`aw-verdict aw-${r.verdict}`}>{USE_LABEL[r.verdict]}</p>
            {r.raised_by_code && (
              <p className="small muted">Code raised this from "appropriate" because it found personal data.</p>
            )}
            <ul>
              {r.reasons.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
            <h4>Data sensitivity</h4>
            <ul>
              {r.data_issues.map((d, i) => (
                <li key={i}>
                  <b>{d.item}</b> ({d.kind}): {d.action}
                </li>
              ))}
            </ul>
            <h4>Redacted version of your description</h4>
            <div className="aw-pre">{r.redacted_description}</div>
            {r.personal_data_found_by_code.length > 0 && (
              <p className="small muted">Code found: {r.personal_data_found_by_code.join(', ')}.</p>
            )}
            <h4>Escalate?</h4>
            <p>
              {r.escalate.needed
                ? `Yes, to a Claude ${r.escalate.to === 'architect' ? 'Architect' : 'Developer'}. ${r.escalate.reason}`
                : 'Not needed. A person using Claude in the app can handle this.'}
            </p>
            <p className="small">{r.safer_approach}</p>
          </>,
        )}
    </div>
  );
}
