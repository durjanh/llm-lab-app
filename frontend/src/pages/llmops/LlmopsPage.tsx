import { useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import {
  POD_HOUR,
  POD_RPS,
  SCALE_DEFAULTS,
  SLO_P95,
  peekingSimulation,
  runPipeline,
  sampleSize,
  simulateDay,
  verdict,
  zTest,
  type ScaleParams,
  type StageId,
  type StageStatus,
} from './llmops';
import { STAGES } from './stages';
import * as S from './snippets';
import './llmops.css';

/* LLMOps: how an AI change gets from a pull request to production and stays healthy. Everything here runs in the
   browser on invented figures; nothing calls a model. */

const SECTIONS: [string, string][] = [
  ['versions', 'What changes'],
  ['pipeline', 'The pipeline'],
  ['yaml', 'Pipeline as code'],
  ['containers', 'Containers'],
  ['kubernetes', 'Kubernetes and scaling'],
  ['where', 'Where to run it'],
  ['ab', 'A/B testing'],
  ['rollback', 'Rollback'],
];

/** Text with `code` spans, as the stage notes are written. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const VERSIONS: [string, string, string][] = [
  [
    'Code',
    'Git commit; the container image is tagged with the commit SHA and the same image moves through every environment.',
    'A hotfix was built on a laptop and pushed as latest. Nobody could say which code was running when the bug report came in.',
  ],
  [
    'Prompt',
    'A file in the repository with a version id, logged on every call. A prompt is code: reviewed, tested, released.',
    'A prompt was edited in a portal on Friday. Refusals tripled; the logs could not show which calls used the new wording.',
  ],
  [
    'Model version',
    'Pinned in the deployment (model name and version), with automatic upgrades off in production. A new version is a release like any other.',
    'The provider moved the deployment to a new default version. Output format changed and a JSON parser started failing.',
  ],
  [
    'Retrieval index',
    'Index name with a version suffix; the chunking settings and embedding model recorded with it. Build the new index beside the old one and switch an alias.',
    'Chunk size changed from 800 to 300 tokens in place. Answers lost their context and there was no old index to go back to.',
  ],
  [
    'Tools',
    'Tool names, descriptions and schemas in code; an MCP server pinned to a version. A changed tool description changes what the model calls.',
    'A tool description was shortened. The model stopped calling it for refunds and started guessing amounts.',
  ],
  [
    'Guardrail config',
    'Content filter policy and blocklists as code (Bicep or Terraform), attached to the deployment by name.',
    'Someone loosened a filter in staging to test, and the setting was copied to production by hand.',
  ],
  [
    'Eval set',
    'Versioned in the repository; changes are reviewed. Scores compare only on the same set, so every result records the set’s version.',
    'Hard cases were dropped from the eval set "because they always fail". The score went up and the product got worse.',
  ],
];

const STATUS_TEXT: Record<StageStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'not run',
  'rolled-back': 'rolled back',
};

function PipelineSection() {
  const [selected, setSelected] = useState<StageId>('evals');
  const [failAt, setFailAt] = useState<StageId | null>(null);
  const run = runPipeline(failAt);
  const stage = STAGES.find((s) => s.id === selected)!;
  const stopped = STAGES.find((s) => s.id === run.stoppedAt);

  return (
    <>
      <p>
        Click a stage to see what it runs and where the lab does the same. Then make one fail: the stages after it never
        run, and the message is what the team would actually receive.
      </p>
      <ol className="lo-pipe" aria-label="Release pipeline stages">
        {STAGES.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`lo-stage ${run.statuses[s.id]}${selected === s.id ? ' on' : ''}`}
              aria-pressed={selected === s.id}
              onClick={() => setSelected(s.id)}
            >
              <span className="lo-n">{i + 1}</span>
              <span className="lo-name">{s.name}</span>
              <span className="lo-st">{STATUS_TEXT[run.statuses[s.id]]}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="row lo-controls">
        <label>
          Make a stage fail{' '}
          <select
            value={failAt ?? ''}
            onChange={(e) => {
              const v = (e.target.value || null) as StageId | null;
              setFailAt(v);
              if (v) setSelected(v);
            }}
          >
            <option value="">None: the release reaches production</option>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid2">
        <div className="card">
          <h3 className="lo-first">{stage.name}</h3>
          <p>
            <Inline text={stage.runs} />
          </p>
          <p className="small muted">
            <b>In this lab:</b> <Inline text={stage.inLab} />
          </p>
        </div>
        <div className={`card lo-outcome ${stopped ? 'bad' : 'good'}`} aria-live="polite">
          {stopped ? (
            <>
              <h3 className="lo-first">
                {run.rolledBack ? 'Rolled back at' : 'Stopped at'}: {stopped.name}
              </h3>
              <pre className="lo-msg">{stopped.failure}</pre>
              <p>{stopped.then}</p>
              <p className="small muted">
                {run.rolledBack
                  ? 'This is the only failure that reached users, and only 5% of them for half an hour. Every earlier gate exists so that this one rarely fires.'
                  : 'No user saw this version. The earlier a stage fails, the cheaper the failure.'}
              </p>
            </>
          ) : (
            <>
              <h3 className="lo-first">Released</h3>
              <p>
                Every gate passed and the approver signed off. The old version stays deployed and warm for a day in case
                the new one needs to be rolled back.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function YamlSection() {
  const [tab, setTab] = useState<'gh' | 'ado'>('gh');
  return (
    <>
      <p>
        The same pipeline twice. Both sign in to Azure with <b>workload identity federation</b>: the CI system issues a
        short-lived token for this run, Entra ID trusts tokens from that repository and branch, and no secret is stored.
        Approvals are set on the <code>production</code> environment, so the job waits for a person before it starts.
        The eval gate is <code>examples/foundry-cicd/eval_gate.py</code>, the same script the lab&apos;s own{' '}
        <code>.github/workflows/infra.yml</code> runs after it provisions the lab&apos;s Azure resources.
      </p>
      <div className="chips" role="tablist" aria-label="Pipeline language">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'gh'}
          className={`chip-btn${tab === 'gh' ? ' on' : ''}`}
          onClick={() => setTab('gh')}
        >
          GitHub Actions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ado'}
          className={`chip-btn${tab === 'ado' ? ' on' : ''}`}
          onClick={() => setTab('ado')}
        >
          Azure DevOps
        </button>
      </div>
      <CodeBlock html={highlight(tab === 'gh' ? S.githubActions : S.azureDevOps, 'shell')} />
      <div className="note">
        Pull requests get no cloud sign-in in this layout: the federated credential trusts the <code>main</code> branch
        only. A pull request can run the fake-model tests; it cannot reach a model deployment or a resource group. The
        eval gate on a pull request therefore needs its own, narrower identity, or runs after merge as here.
      </div>
    </>
  );
}

// ---------- autoscaling ----------

const PRESETS: [string, string, Partial<ScaleParams>][] = [
  ['Defaults', 'Scale on requests in progress, start in 2 minutes, at least 3 pods.', {}],
  [
    'Scale on CPU',
    'The service spends its time waiting on the model, so CPU stays low and the autoscaler never adds pods.',
    { metric: 'cpu' },
  ],
  [
    'Slow start, one pod',
    'One pod overnight, 10 minutes to start (a large image, a model loaded at start-up), one pod at a time.',
    { minReplicas: 1, startupMinutes: 10, maxStepUp: 1 },
  ],
  ['Provision for the peak', '20 pods all day: never slow, and several times the cost.', { minReplicas: 20 }],
];

const W = 720;
const PAD = { l: 40, r: 10, t: 10, b: 22 };

/** A line chart of one value over the day, sampled every five minutes. */
function DayChart({
  series,
  max,
  height,
  unit,
  label,
}: {
  series: { values: number[]; cls: string; name: string }[];
  max: number;
  height: number;
  unit: string;
  label: string;
}) {
  const iw = W - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const x = (m: number) => PAD.l + (m / 1440) * iw;
  const y = (v: number) => PAD.t + ih - (Math.min(v, max) / max) * ih;
  const path = (vals: number[]) => {
    let d = '';
    for (let m = 0; m < vals.length; m += 5) d += `${m ? 'L' : 'M'}${x(m).toFixed(1)} ${y(vals[m]).toFixed(1)}`;
    return d;
  };
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="lo-chart" role="img" aria-label={label}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="lo-grid" />
          <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="lo-ax">
            {t}
            {unit}
          </text>
        </g>
      ))}
      {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
        <text key={h} x={x(h * 60)} y={height - 6} textAnchor="middle" className="lo-ax">
          {String(h).padStart(2, '0')}:00
        </text>
      ))}
      {series.map((s) => (
        <path key={s.name} d={path(s.values)} className={`lo-line ${s.cls}`} />
      ))}
    </svg>
  );
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');

function AutoscaleSim() {
  const [p, setP] = useState<ScaleParams>(SCALE_DEFAULTS);
  const day = useMemo(() => simulateDay(p), [p]);
  const set = <K extends keyof ScaleParams>(k: K, v: ScaleParams[K]) => setP((o) => ({ ...o, [k]: v }));
  const capacity = day.pods.map((n) => n * POD_RPS);
  const limit = day.load.map(() => p.modelLimit);
  const num = (
    k: 'minReplicas' | 'maxReplicas' | 'startupMinutes' | 'maxStepUp' | 'modelLimit',
    lo: number,
    hi: number,
  ) => (
    <input
      type="number"
      min={lo}
      max={hi}
      value={p[k]}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) set(k, Math.min(hi, Math.max(lo, v)));
      }}
    />
  );

  return (
    <div className="card lo-sim">
      <div className="chips" aria-label="Presets">
        {PRESETS.map(([name, , over]) => (
          <button key={name} type="button" className="chip-btn" onClick={() => setP({ ...SCALE_DEFAULTS, ...over })}>
            {name}
          </button>
        ))}
      </div>
      <p className="small muted lo-preset-help">
        {PRESETS.map(([name, help]) => (
          <span key={name}>
            <b>{name}:</b> {help}{' '}
          </span>
        ))}
      </p>
      <div className="lo-fields">
        <label>
          <span>Scale on</span>
          <select value={p.metric} onChange={(e) => set('metric', e.target.value as ScaleParams['metric'])}>
            <option value="inflight">Requests in progress</option>
            <option value="cpu">CPU</option>
          </select>
        </label>
        <label>
          <span>Target use</span>
          <span className="row">
            <input
              type="range"
              min={0.3}
              max={0.9}
              step={0.05}
              value={p.target}
              onChange={(e) => set('target', Number(e.target.value))}
            />
            <b>{Math.round(p.target * 100)}%</b>
          </span>
        </label>
        <label>
          <span>Min pods</span>
          {num('minReplicas', 1, 30)}
        </label>
        <label>
          <span>Max pods</span>
          {num('maxReplicas', 1, 40)}
        </label>
        <label>
          <span>Start-up (min)</span>
          {num('startupMinutes', 0, 30)}
        </label>
        <label>
          <span>New pods a minute</span>
          {num('maxStepUp', 1, 20)}
        </label>
        <label>
          <span>Model limit (req/s)</span>
          {num('modelLimit', 5, 100)}
        </label>
      </div>

      <div className="stats" aria-live="polite">
        <div className="stat">
          <div className={`v${day.minutesOverSlo > 30 ? ' lo-bad' : ''}`}>{fmt(day.minutesOverSlo)}</div>
          <div className="k">minutes over the {SLO_P95} s p95 objective</div>
        </div>
        <div className="stat">
          <div className={`v${day.timedOut > 0 ? ' lo-bad' : ''}`}>{fmt(day.timedOut)}</div>
          <div className="k">requests timed out in the queue</div>
        </div>
        <div className="stat">
          <div className={`v${day.rateLimited > 0 ? ' lo-warn' : ''}`}>{fmt(day.rateLimited)}</div>
          <div className="k">requests refused by the model (429)</div>
        </div>
        <div className="stat">
          <div className="v">{day.peakPods}</div>
          <div className="k">pods at the peak</div>
        </div>
        <div className="stat">
          <div className="v">£{day.cost.toFixed(2)}</div>
          <div className="k">
            {day.podHours.toFixed(0)} pod-hours at £{POD_HOUR.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="lo-legend small">
        <span className="lo-key load">traffic</span>
        <span className="lo-key cap">pod capacity</span>
        <span className="lo-key limit">model limit</span>
      </div>
      <DayChart
        label="Traffic, pod capacity and the model's limit over the day, in requests a second"
        height={200}
        max={60}
        unit=""
        series={[
          { values: day.load, cls: 'load', name: 'load' },
          { values: capacity, cls: 'cap', name: 'cap' },
          { values: limit, cls: 'limit', name: 'limit' },
        ]}
      />
      <div className="lo-legend small">
        <span className="lo-key p95">p95 latency</span>
        <span className="lo-key slo">objective</span>
      </div>
      <DayChart
        label="p95 latency over the day, in seconds, against the objective"
        height={150}
        max={40}
        unit="s"
        series={[
          { values: day.p95, cls: 'p95', name: 'p95' },
          { values: day.load.map(() => SLO_P95), cls: 'slo', name: 'slo' },
        ]}
      />
      <p className="small muted">
        One pod holds 16 requests at once and each waits about 4 seconds on the model, so a pod serves {POD_RPS}{' '}
        requests a second. Requests queue in front of the pods and time out after a minute. Pods are removed only after
        five quiet minutes. Traffic is invented: two working peaks and a newsletter at 13:00.
      </p>
    </div>
  );
}

// ---------- A/B testing ----------

function SampleSizeCalc() {
  const [base, setBase] = useState(30);
  const [mde, setMde] = useState(3);
  const [alpha, setAlpha] = useState(5);
  const [power, setPower] = useState(80);
  const [daily, setDaily] = useState(1000);
  const n = sampleSize(base / 100, mde / 100, alpha / 100, power / 100);
  const days = n && daily > 0 ? Math.ceil((2 * n) / daily) : null;
  return (
    <div className="card">
      <h3 className="lo-first">How many users before you look</h3>
      <div className="lo-fields">
        <label>
          <span>Current rate (%)</span>
          <input type="number" min={1} max={99} value={base} onChange={(e) => setBase(Number(e.target.value))} />
        </label>
        <label>
          <span>Smallest change worth finding (points)</span>
          <input type="number" min={0.1} step={0.1} value={mde} onChange={(e) => setMde(Number(e.target.value))} />
        </label>
        <label>
          <span>Alpha (%)</span>
          <input
            type="number"
            min={0.1}
            max={20}
            step={0.1}
            value={alpha}
            onChange={(e) => setAlpha(Number(e.target.value))}
          />
        </label>
        <label>
          <span>Power (%)</span>
          <input type="number" min={50} max={99} value={power} onChange={(e) => setPower(Number(e.target.value))} />
        </label>
        <label>
          <span>Users a day (both arms)</span>
          <input type="number" min={1} value={daily} onChange={(e) => setDaily(Number(e.target.value))} />
        </label>
      </div>
      <div className="stats" aria-live="polite">
        <div className="stat">
          <div className="v">{n ? fmt(n) : '—'}</div>
          <div className="k">users in each arm</div>
        </div>
        <div className="stat">
          <div className="v">{days ?? '—'}</div>
          <div className="k">days at this traffic</div>
        </div>
      </div>
      <p className="small muted">
        Halving the change you want to detect needs about four times the users. Decide this number before the test
        starts, and do not stop early because the result looks good.
      </p>
    </div>
  );
}

const VERDICT_TEXT = {
  ship: ['Ship B', 'good'],
  vetoed: ['B wins, but a guardrail vetoes it', 'bad'],
  'no-difference': ['No significant difference: keep A, or run longer if the plan said so', 'warn'],
  worse: ['B is significantly worse', 'bad'],
  invalid: ['Check the counts: successes must be between 0 and the users in each arm', 'warn'],
} as const;

function SignificanceCheck() {
  const [c, setC] = useState({
    nA: 4000,
    sA: 1200,
    nB: 4000,
    sB: 1320,
    costA: 1.2,
    costB: 1.25,
    p95A: 5.8,
    p95B: 6.1,
    refA: 0.8,
    refB: 1.1,
  });
  const set = (k: keyof typeof c) => (e: ChangeEvent<HTMLInputElement>) =>
    setC((o) => ({ ...o, [k]: Number(e.target.value) }));
  const t = zTest(c.sA, c.nA, c.sB, c.nB);
  const v = verdict(
    t,
    { costA: c.costA, costB: c.costB, p95A: c.p95A, p95B: c.p95B, refusalA: c.refA / 100, refusalB: c.refB / 100 },
    { cost: 0.1, p95: 0.2, refusal: 0.01 },
  );
  const [text, tone] = VERDICT_TEXT[v.decision];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const field = (k: keyof typeof c, label: string, step = 1) => (
    <input type="number" min={0} step={step} value={c[k]} onChange={set(k)} aria-label={label} />
  );
  return (
    <div className="card">
      <h3 className="lo-first">Did B win, and may it ship?</h3>
      <p className="small muted">
        The main metric is the share of answers users marked helpful. Guardrails: cost per task may rise at most 10%,
        p95 latency at most 20%, refusal rate at most 1 point.
      </p>
      <div className="table-wrap">
        <table className="t lo-ab">
          <thead>
            <tr>
              <th />
              <th>Users</th>
              <th>Helpful</th>
              <th>Cost per task (p)</th>
              <th>p95 (s)</th>
              <th>Refusals (%)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>A (current)</th>
              <td>{field('nA', 'Users in A')}</td>
              <td>{field('sA', 'Helpful in A')}</td>
              <td>{field('costA', 'Cost in A', 0.01)}</td>
              <td>{field('p95A', 'p95 in A', 0.1)}</td>
              <td>{field('refA', 'Refusals in A', 0.1)}</td>
            </tr>
            <tr>
              <th>B (new prompt)</th>
              <td>{field('nB', 'Users in B')}</td>
              <td>{field('sB', 'Helpful in B')}</td>
              <td>{field('costB', 'Cost in B', 0.01)}</td>
              <td>{field('p95B', 'p95 in B', 0.1)}</td>
              <td>{field('refB', 'Refusals in B', 0.1)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {t && (
        <p className="small">
          Helpful: A {pct(t.rateA)}, B {pct(t.rateB)}. Difference {t.diff >= 0 ? '+' : ''}
          {(t.diff * 100).toFixed(2)} points, 95% interval {(t.low * 100).toFixed(2)} to {(t.high * 100).toFixed(2)}. z
          = {t.z.toFixed(2)}, p = {t.p < 0.0001 ? '< 0.0001' : t.p.toFixed(4)}.
        </p>
      )}
      <p className={`lo-verdict ${tone}`} aria-live="polite">
        <b>{text}</b>
        {v.broken.length > 0 && <> (breaks: {v.broken.join(', ')})</>}
      </p>
      <div className="chips">
        <button type="button" className="btn small" onClick={() => setC((o) => ({ ...o, costB: 1.6 }))}>
          Make B 33% dearer
        </button>
        <button type="button" className="btn small" onClick={() => setC((o) => ({ ...o, sB: 1240 }))}>
          Make B only slightly better
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => setC((o) => ({ ...o, sB: 1320, costB: 1.25, refB: 1.1 }))}
        >
          Reset B
        </button>
      </div>
    </div>
  );
}

function PeekingDemo() {
  const [seed, setSeed] = useState(1);
  const r = useMemo(() => peekingSimulation(seed, 300, 14, 300, 0.3), [seed]);
  const share = (n: number) => `${Math.round((n / r.tests) * 100)}%`;
  const bars: [string, number, string][] = [
    ['Look once, at day 14', r.endOnly, 'good'],
    ['Look every day, stop at p < 0.05', r.daily, 'bad'],
    ['Look every day, stop at p < 0.01', r.dailyStrict, 'warn'],
  ];
  return (
    <div className="card">
      <h3 className="lo-first">Why peeking every day finds winners that are not there</h3>
      <p>
        300 A/A tests: both arms get the same prompt, so every &ldquo;winner&rdquo; is a false positive. Each runs 14
        days with 300 users a day in each arm. At a 5% significance level, about 5% should look like winners.
      </p>
      <div className="lo-bars" aria-live="polite">
        {bars.map(([label, n, tone]) => (
          <div key={label} className="lo-bar-row">
            <span className="small">{label}</span>
            <span className="lo-bar-track">
              <span className={`lo-bar ${tone}`} style={{ width: `${(n / r.tests) * 100}%` }} />
            </span>
            <b>{share(n)}</b>
          </div>
        ))}
      </div>
      <div className="row">
        <button type="button" className="btn small" onClick={() => setSeed((s) => s + 1)}>
          Run 300 more
        </button>
        <span className="small muted">Seed {seed}</span>
      </div>
      <p className="small muted">
        Fourteen looks give fourteen chances for noise to cross the line. Either fix the sample size and look once, or
        use a sequential method that spends the 5% across the looks: a stricter threshold on each look is the simple
        version of that.
      </p>
    </div>
  );
}

export default function LlmopsPage() {
  return (
    <main className="page-llmops">
      <p className="kicker">LLMOps and CI/CD</p>
      <h1>Shipping AI changes safely</h1>
      <p className="lede">
        An AI system changes in more places than ordinary software: the code, the prompt, the model version, the index,
        the tools and the guardrails. This page follows one change from a pull request to production: the gates it must
        pass, the container it runs in, how it scales, and how to tell whether users are better off with it. Everything
        runs in your browser on invented figures.
      </p>
      <nav className="lo-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="versions" className="lo-section">
        <h2>1. What changes, and how each is versioned</h2>
        <p>
          If something can change the answer, it needs a version, and the version must be in the log of every call.
          Otherwise a regression cannot be traced to its cause or undone.
        </p>
        <Table
          head={['What', 'How to version it', 'What broke when it was not']}
          rows={VERSIONS.map((r) => [<b key="w">{r[0]}</b>, r[1], r[2]])}
        />
        <p className="small muted">
          The lab pins its Azure model deployments in Bicep (<code>examples/foundry-cicd/deployments.bicep</code>: model
          version, capacity, upgrade policy and content filter in one file). <Link to="/evals">Evals</Link> covers
          building the eval set.
        </p>
      </section>

      <section id="pipeline" className="lo-section">
        <h2>2. The pipeline, stage by stage</h2>
        <PipelineSection />
      </section>

      <section id="yaml" className="lo-section">
        <h2>3. Pipeline as code</h2>
        <YamlSection />
      </section>

      <section id="containers" className="lo-section">
        <h2>4. Containers</h2>
        <p>
          A multi-stage build keeps compilers and caches out of the image that runs. The process runs as an unprivileged
          user. The image holds no keys: at run time the container signs in with its managed identity, so a leaked image
          leaks nothing that opens a door.
        </p>
        <div className="grid2">
          <CodeBlock html={highlight(S.dockerfile, 'shell')} />
          <div>
            <CodeBlock html={highlight(S.dockerignore, 'shell')} />
            <h3>What stays out of the image</h3>
            <ul>
              <li>
                <b>
                  Keys and <code>.env</code>
                </b>
                : configuration comes from the environment, identity from the platform.
              </li>
              <li>
                <b>Model weights</b>, unless the container serves the model itself. A 5 GB image takes minutes to pull,
                and every minute is a minute a new pod cannot take traffic (see the start-up time below).
              </li>
              <li>
                <b>Runtime data</b>: caches, uploads and logs go to storage, so any pod can be replaced at any time.
              </li>
              <li>
                <b>
                  The <code>latest</code> tag
                </b>
                : deploy by commit SHA or digest, so a rollback is a pointer change.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section id="kubernetes" className="lo-section">
        <h2>5. Kubernetes for AI services, and scaling</h2>
        <p>
          The pieces that matter: a <b>Deployment</b> runs identical pods, a <b>Service</b> gives them one address,{' '}
          <b>probes</b> keep traffic off a pod until it is ready and restart one that hangs, <b>resource requests</b>{' '}
          let the scheduler place pods, a <b>HorizontalPodAutoscaler</b> adds and removes pods, and{' '}
          <b>workload identity</b> gives each pod an Entra ID token with no secret in the cluster.
        </p>
        <CodeBlock html={highlight(S.kubernetes, 'shell')} />
        <p>
          The autoscaler sets the number of pods to <code>ceil(pods × observed ÷ target)</code>. The question is what to
          observe. A service that calls a hosted model spends most of each request waiting on the network, so its CPU
          stays low while its request slots fill. Try the presets.
        </p>
        <AutoscaleSim />
        <div className="note">
          <b>When the model is the bottleneck, pods do not help.</b> The red dashed line is the model deployment&apos;s
          own limit. Above it the model answers 429 whatever the number of pods, and more pods only send more requests
          into the limit. Raise the quota, spread across deployments or regions, or degrade gracefully:{' '}
          <Link to="/resilience">Rate limits and resilience</Link> and <Link to="/model-failover">Model failover</Link>{' '}
          show both. <Link to="/observability">Monitoring and traces</Link> shows where the time in a request goes.
        </div>
      </section>

      <section id="where" className="lo-section">
        <h2>6. Where to run it</h2>
        <p>
          Most AI backends that call a hosted model are ordinary web services, and the simplest platform that scales on
          requests is usually the right one. Kubernetes earns its cost when you run many services, need GPUs you
          schedule yourself, or must control the network closely.
        </p>
        <Table
          head={['Platform', 'What it is', 'When it fits']}
          rows={[
            [
              <b key="p">Azure Container Apps</b>,
              'Serverless containers on a managed Kubernetes base; KEDA scaling, scale to zero, revisions with traffic splitting.',
              'The default for an API in front of a hosted model on Azure. Canary by revision weight, no cluster to run.',
            ],
            [
              <b key="p">App Service</b>,
              'Managed web hosting for code or containers, with deployment slots you swap.',
              'One web app or API, a team used to it, blue-green by slot swap. No scale to zero.',
            ],
            [
              <b key="p">AKS</b>,
              'Managed Kubernetes on Azure: you run the workloads and node pools, Azure runs the control plane.',
              'Many services, GPU node pools for self-hosted models, service mesh, strict network control, or a platform team already in place.',
            ],
            [
              <b key="p">Cloud Run</b>,
              'Serverless containers on Google Cloud; per-request concurrency setting, scale to zero, revisions with traffic splitting.',
              'The Google Cloud equivalent of Container Apps, next to Vertex AI.',
            ],
            [
              <b key="p">GKE</b>,
              'Managed Kubernetes on Google Cloud, with an Autopilot mode that manages the nodes too.',
              'As AKS, on Google Cloud.',
            ],
            [
              <b key="p">ECS on Fargate</b>,
              'AWS containers without servers to manage: tasks and services, no Kubernetes.',
              'A containerised API next to Bedrock when the team does not want Kubernetes.',
            ],
            [<b key="p">EKS</b>, 'Managed Kubernetes on AWS.', 'As AKS, on AWS.'],
          ]}
        />
      </section>

      <section id="ab" className="lo-section">
        <h2>7. A/B testing a prompt or model change</h2>
        <p>
          An offline eval says a change is not worse on the cases you thought of. Only real traffic says whether users
          are better off. Split users at random (by user, not by request, so one person sees one version), fix the
          sample size first, and decide in advance which guardrails can veto a winner. A prompt that helps more people
          but costs a third more, or refuses more often, may not be a win.
        </p>
        <div className="grid2">
          <SampleSizeCalc />
          <SignificanceCheck />
        </div>
        <PeekingDemo />
      </section>

      <section id="rollback" className="lo-section">
        <h2>8. Rollback and release hygiene</h2>
        <ul>
          <li>
            <b>Prompts behind a flag.</b> The prompt version is configuration read at request time, so switching back
            takes seconds and needs no build. The flag also carries the A/B split.
          </li>
          <li>
            <b>Keep the previous model deployment warm.</b> Run the new model version as a new deployment beside the old
            one, move traffic, and delete the old deployment only after a full day of normal traffic.
          </li>
          <li>
            <b>Pin model versions</b> and turn off automatic upgrades in production. Test a new version as a release.
          </li>
          <li>
            <b>Roll back by pointer.</b> An image digest, a revision weight, an index alias, a prompt version: each
            rollback is one change, rehearsed, not a rebuild under pressure.
          </li>
          <li>
            <b>Roll forward only with evidence.</b> If a fix is faster than a rollback, it still goes through the gates.
          </li>
        </ul>
        <div className="takeaways">
          <h3>What to take away</h3>
          <ul>
            <li>Version everything that can change an answer, and log the versions with every call.</li>
            <li>
              Gates are cheapest early: fake-model tests, then an eval gate with quality, cost and latency budgets, then
              staging, then a small canary.
            </li>
            <li>Build one image, sign in with federated identity, and keep keys out of images and pipelines.</li>
            <li>
              Scale an I/O-bound AI service on requests in progress, not CPU, and remember the model&apos;s own limit.
            </li>
            <li>Decide an A/B test&apos;s sample size and guardrails before it starts, and do not stop on a peek.</li>
          </ul>
          <p className="small">
            Related: <Link to="/evals">Evals</Link>, <Link to="/foundry-operations">Foundry operations</Link> (quotas,
            monitoring and an evaluation gate on live deployments),{' '}
            <Link to="/observability">Monitoring and traces</Link>, <Link to="/mlops">MLOps</Link> for classic models.
          </p>
        </div>
      </section>
    </main>
  );
}
