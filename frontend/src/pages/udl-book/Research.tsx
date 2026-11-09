import { useMemo, useState } from 'react';
import { Chips, Slider } from '../deep-learning/Notebook';
import { FRONTIER, LEVERS } from './research_data';
import type { Lever, LeverTag, Source } from './types';

/** The research part's sections, for the page's contents list: [anchor, label]. */
export const RESEARCH_SECTIONS: [string, string][] = [
  ['rs-sim', 'What-if estimator'],
  ['rs-levers', 'The levers and the evidence'],
  ['rs-frontier', 'What comes next'],
  ['rs-read', 'Reading the evidence'],
];

/* ------------------------------------------------------------------ the estimator */

interface ModelPreset {
  id: string;
  label: string;
  total: number; // parameters, billions
  active: number; // parameters used per token, billions (equal to total for a dense model)
  layers: number;
  qHeads: number;
  kvHeads: number;
  headDim: number;
  /** Multi-head latent attention caches one compressed vector per layer of this size, instead of keys and values. */
  mlaDim?: number;
  note: string;
}

// Shapes from the models' published configurations; "-like" because the estimator ignores smaller details.
const MODELS: ModelPreset[] = [
  {
    id: '8b',
    label: 'Dense 8B',
    total: 8,
    active: 8,
    layers: 32,
    qHeads: 32,
    kvHeads: 8,
    headDim: 128,
    note: 'Llama 3.1 8B-like: grouped-query attention, 8 KV heads',
  },
  {
    id: '70b',
    label: 'Dense 70B',
    total: 70.6,
    active: 70.6,
    layers: 80,
    qHeads: 64,
    kvHeads: 8,
    headDim: 128,
    note: 'Llama 3.1 70B-like: grouped-query attention, 8 KV heads',
  },
  {
    id: 'mixtral',
    label: 'MoE 47B (13B active)',
    total: 46.7,
    active: 12.9,
    layers: 32,
    qHeads: 32,
    kvHeads: 8,
    headDim: 128,
    note: 'Mixtral 8x7B-like: 2 of 8 experts per token',
  },
  {
    id: 'dsv3',
    label: 'MoE 671B (37B active)',
    total: 671,
    active: 37,
    layers: 61,
    qHeads: 128,
    kvHeads: 128,
    headDim: 128,
    mlaDim: 576,
    note: 'DeepSeek-V3-like: multi-head latent attention, 576 cached numbers per layer',
  },
];

interface Gpu {
  id: string;
  label: string;
  bw: number; // GB/s
  mem: number; // GB
  tflops: number; // dense BF16
}

// Spec-sheet figures: H100 and B200 as on the Hardware page, H200 from NVIDIA's data sheet.
const GPUS: Gpu[] = [
  { id: 'h100', label: 'H100 SXM', bw: 3350, mem: 80, tflops: 989 },
  { id: 'h200', label: 'H200', bw: 4800, mem: 141, tflops: 989 },
  { id: 'b200', label: 'B200', bw: 8000, mem: 192, tflops: 2250 },
];

type Precision = 'bf16' | 'fp8' | 'int4';
const BYTES: Record<Precision, number> = { bf16: 2, fp8: 1, int4: 0.5 };

interface Choices {
  weights: Precision;
  kv: Exclude<Precision, 'int4'>;
  /** Cache keys and values for every query head, as the original transformer did, or use the model's own layout. */
  fullKv: boolean;
  spec: boolean;
}

interface Setting {
  model: ModelPreset;
  gpu: Gpu;
  batch: number;
  context: number;
  price: number; // $ per GPU-hour
  alpha: number; // speculative decoding: chance the target model accepts each drafted token
  gamma: number; // tokens drafted per step
  draftCost: number; // the draft model's cost per token, as a fraction of the target's
}

interface Estimate {
  weightsGB: number;
  kvGB: number;
  gpus: number;
  perUser: number; // tokens a second each user sees
  total: number; // tokens a second across the batch
  dollarsPerM: number; // $ per million output tokens
  bound: 'memory' | 'compute';
}

/**
 * A decode-speed ceiling from first principles. Each step reads the weights it uses and every sequence's KV cache
 * from memory, and does 2 FLOPs per active parameter per token; the step takes whichever is longer. Speculative
 * decoding (Leviathan et al., 2023) verifies γ drafted tokens in one step and keeps, on average,
 * (1 − α^(γ+1)) / (1 − α) of them. Real servers run below these ceilings.
 */
function estimate(s: Setting, c: Choices): Estimate {
  const m = s.model;
  const wBytes = BYTES[c.weights];
  const kvBytes = BYTES[c.kv];
  const weightsGB = m.total * wBytes;
  const perTokenKv = c.fullKv
    ? 2 * m.layers * m.qHeads * m.headDim * kvBytes
    : m.mlaDim
      ? m.layers * m.mlaDim * kvBytes
      : 2 * m.layers * m.kvHeads * m.headDim * kvBytes;
  const kvGB = (perTokenKv * s.context * s.batch) / 1e9;
  const gpus = Math.max(1, Math.ceil((weightsGB + kvGB) / (s.gpu.mem * 0.9)));
  const bw = gpus * s.gpu.bw * 1e9;
  const flops = gpus * s.gpu.tflops * 1e12;
  // A mixture of experts reads only the active experts for one sequence, but a batch touches more of them.
  const readGB = Math.min(m.total, m.active * s.batch) * wBytes + kvGB;
  const tMem = (readGB * 1e9) / bw;
  const verified = c.spec ? s.gamma + 1 : 1;
  const tComp = (2 * m.active * 1e9 * s.batch * verified) / flops;
  const tStep = Math.max(tMem, tComp) + (c.spec ? s.gamma * s.draftCost * tMem : 0);
  const kept = c.spec ? (1 - s.alpha ** (s.gamma + 1)) / (1 - s.alpha) : 1;
  const perUser = kept / tStep;
  const total = perUser * s.batch;
  return {
    weightsGB,
    kvGB,
    gpus,
    perUser,
    total,
    dollarsPerM: ((gpus * s.price) / (total * 3600)) * 1e6,
    bound: tComp > tMem ? 'compute' : 'memory',
  };
}

const gb = (v: number) =>
  v >= 100 ? `${v.toFixed(0)} GB` : v >= 1 ? `${v.toFixed(1)} GB` : `${(v * 1000).toFixed(0)} MB`;
const rate = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 1 : 0));
const money = (v: number) => (v >= 10 ? `$${v.toFixed(0)}` : v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);

function Bar({
  label,
  value,
  max,
  colour,
  text,
}: {
  label: string;
  value: number;
  max: number;
  colour: string;
  text: string;
}) {
  return (
    <div className="ub-bar">
      <span>{label}</span>
      <div>
        <i style={{ width: `${Math.max(1, Math.min(100, (100 * value) / max))}%`, background: colour }} />
      </div>
      <span className="mono">{text}</span>
    </div>
  );
}

const BASELINE: Choices = { weights: 'bf16', kv: 'bf16', fullKv: true, spec: false };

function Estimator() {
  const [modelId, setModelId] = useState('70b');
  const [gpuId, setGpuId] = useState('h100');
  const [batch, setBatch] = useState(16);
  const [context, setContext] = useState(8192);
  const [price, setPrice] = useState(3);
  const [weights, setWeights] = useState<Precision>('fp8');
  const [kv, setKv] = useState<Choices['kv']>('fp8');
  const [fullKv, setFullKv] = useState(false);
  const [spec, setSpec] = useState(true);
  const [alpha, setAlpha] = useState(0.7);
  const [gamma, setGamma] = useState(4);
  const [draftCost, setDraftCost] = useState(0.05);

  const model = MODELS.find((m) => m.id === modelId)!;
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  const setting: Setting = { model, gpu, batch, context, price, alpha, gamma, draftCost };
  const base = estimate(setting, BASELINE);
  const yours = estimate(setting, { weights, kv, fullKv, spec });
  const memMax = Math.max(base.weightsGB + base.kvGB, yours.weightsGB + yours.kvGB);
  /** "memory 5.3× lower": how a value compares with the baseline, or "about the same" within 5%. */
  const versus = (label: string, a: number, b: number, up: string, down: string) => {
    if (Math.abs(a / b - 1) < 0.05) return `${label} about the same`;
    return a > b ? `${label} ${(a / b).toFixed(1)}× ${up}` : `${label} ${(b / a).toFixed(1)}× ${down}`;
  };

  return (
    <section id="rs-sim" className="ub-chapter">
      <h2>What-if estimator: serving one model, with and without the tricks</h2>
      <div className="ub-offers">
        <p>
          Pick a model and a GPU, then switch on the changes that research has made standard. The estimator compares a
          plain baseline (16-bit weights, a full multi-head KV cache, no speculative decoding) with your choices, using
          the arithmetic from chapter 12 and the Hardware page. Generating a token reads the weights and every
          sequence&apos;s cache from memory, so at small batches the speed limit is memory bandwidth, not arithmetic.
        </p>
      </div>
      <div className="ub-sim card" style={{ marginTop: 12 }}>
        <div className="dl-body">
          <fieldset>
            <legend>Model</legend>
            <Chips options={MODELS.map((m) => ({ id: m.id, label: m.label }))} value={modelId} onChange={setModelId} />
            <p className="dl-caption">{model.note}</p>
          </fieldset>
          <fieldset>
            <legend>Hardware and load</legend>
            <Chips options={GPUS.map((g) => ({ id: g.id, label: g.label }))} value={gpuId} onChange={setGpuId} />
            <div className="dl-controls" style={{ marginTop: 6 }}>
              <Slider
                label="Users at once"
                value={Math.log2(batch)}
                min={0}
                max={8}
                step={1}
                onChange={(v) => setBatch(2 ** v)}
                show={() => String(batch)}
              />
              <Slider
                label="Context"
                value={Math.log2(context)}
                min={10}
                max={17}
                step={1}
                onChange={(v) => setContext(2 ** v)}
                show={() => `${context / 1024}k`}
              />
              <Slider
                label="$ per GPU-hour"
                value={price}
                min={1}
                max={10}
                step={0.5}
                onChange={setPrice}
                show={(v) => `$${v}`}
              />
            </div>
          </fieldset>
        </div>
        <div className="dl-body">
          <fieldset>
            <legend>Your changes</legend>
            <div className="small muted">Weights</div>
            <Chips
              options={[
                { id: 'bf16', label: 'BF16' },
                { id: 'fp8', label: 'FP8' },
                { id: 'int4', label: 'INT4' },
              ]}
              value={weights}
              onChange={setWeights}
            />
            <div className="small muted" style={{ marginTop: 6 }}>
              KV cache
            </div>
            <Chips
              options={[
                { id: 'bf16', label: 'BF16' },
                { id: 'fp8', label: 'FP8' },
              ]}
              value={kv}
              onChange={setKv}
            />
            <label className="ub-check">
              <input type="checkbox" checked={!fullKv} onChange={(e) => setFullKv(!e.target.checked)} />
              Use the model&apos;s compact KV layout (
              {model.mlaDim ? 'latent attention' : `${model.kvHeads} KV heads for ${model.qHeads} query heads`})
            </label>
            <label className="ub-check">
              <input type="checkbox" checked={spec} onChange={(e) => setSpec(e.target.checked)} />
              Speculative decoding
            </label>
            {spec && (
              <div className="dl-controls">
                <Slider label="Acceptance α" value={alpha} min={0.3} max={0.95} step={0.05} onChange={setAlpha} />
                <Slider label="Drafted γ" value={gamma} min={1} max={8} step={1} onChange={setGamma} />
                <Slider label="Draft cost c" value={draftCost} min={0} max={0.3} step={0.01} onChange={setDraftCost} />
              </div>
            )}
          </fieldset>
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="ub-bars">
          <b className="small">Memory to hold the model and every user&apos;s cache</b>
          <Bar
            label="Baseline"
            value={base.weightsGB + base.kvGB}
            max={memMax}
            colour="var(--muted)"
            text={`${gb(base.weightsGB + base.kvGB)} · ${base.gpus} GPU${base.gpus > 1 ? 's' : ''}`}
          />
          <Bar
            label="Your choices"
            value={yours.weightsGB + yours.kvGB}
            max={memMax}
            colour="var(--s3)"
            text={`${gb(yours.weightsGB + yours.kvGB)} · ${yours.gpus} GPU${yours.gpus > 1 ? 's' : ''}`}
          />
          <b className="small" style={{ marginTop: 6 }}>
            Speed each user sees (tokens a second, ceiling)
          </b>
          <Bar
            label="Baseline"
            value={base.perUser}
            max={Math.max(base.perUser, yours.perUser)}
            colour="var(--muted)"
            text={rate(base.perUser)}
          />
          <Bar
            label="Your choices"
            value={yours.perUser}
            max={Math.max(base.perUser, yours.perUser)}
            colour="var(--s1)"
            text={rate(yours.perUser)}
          />
          <b className="small" style={{ marginTop: 6 }}>
            Cost per million output tokens
          </b>
          <Bar
            label="Baseline"
            value={base.dollarsPerM}
            max={Math.max(base.dollarsPerM, yours.dollarsPerM)}
            colour="var(--muted)"
            text={money(base.dollarsPerM)}
          />
          <Bar
            label="Your choices"
            value={yours.dollarsPerM}
            max={Math.max(base.dollarsPerM, yours.dollarsPerM)}
            colour="var(--s2)"
            text={money(yours.dollarsPerM)}
          />
        </div>
        <p className="small" style={{ marginTop: 12 }}>
          Against the baseline:{' '}
          {versus('memory', yours.weightsGB + yours.kvGB, base.weightsGB + base.kvGB, 'higher', 'lower')} (weights{' '}
          {gb(yours.weightsGB)}, cache {gb(yours.kvGB)}),{' '}
          {versus('speed per user', yours.perUser, base.perUser, 'faster', 'slower')},{' '}
          {versus('cost per token', yours.dollarsPerM, base.dollarsPerM, 'higher', 'lower')}. The step is {yours.bound}
          -bound
          {yours.bound === 'compute' && spec
            ? '. Checking the drafted tokens takes GPU time that is already short, so speculative decoding helps less here and can slow each user down.'
            : '.'}
        </p>
        <p className="dl-caption">
          Ceilings, not benchmarks: real servers run below them, and prefill (reading the prompt) is not counted. The
          estimator says nothing about quality. Lower precision can cost accuracy, which the evidence below measures and
          your own evals must confirm. GPUs are added when the model and cache need more than 90% of one GPU&apos;s
          memory, and their bandwidth is assumed to add up (tensor parallelism, minus the cost of combining results).
        </p>
      </div>
      <div className="dl-try small">
        <b>Try this</b>
        <ul>
          <li>
            Dense 70B on H100 with 16 users at 8k: switch off the compact KV layout. The cache grows eightfold, from 21
            GB to 172 GB, and the model needs 4 GPUs instead of 2. That is the case for grouped-query attention.
          </li>
          <li>
            Set users to 1, switch off speculative decoding and pick INT4 weights. The model fits on 1 GPU instead of 3,
            so each token costs about 4× less. Each user gets only about 1.4× more speed, because the baseline&apos;s
            three GPUs were sharing the reading.
          </li>
          <li>
            Set users to 256 and context to 1k, then switch speculative decoding on and off. With it on, each user gets
            about half the speed: the step is compute-bound, and checking five tokens to keep fewer than three costs
            more than it saves. At 8k context the same batch is held back by memory, so drafting still helps: 80 tokens
            a second against 49.
          </li>
          <li>
            Try the 671B mixture of experts: it takes 10 GPUs to hold at FP8, but one token uses only 37B parameters.
          </li>
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ the levers */

const TAGS: { id: 'all' | LeverTag; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'speed', label: 'Speed' },
  { id: 'quality', label: 'Quality' },
  { id: 'cost', label: 'Cost' },
  { id: 'memory', label: 'Memory' },
];

const STAGES: { id: 'all' | Lever['stage']; label: string }[] = [
  { id: 'all', label: 'Every stage' },
  { id: 'training', label: 'Training' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'inference', label: 'Inference' },
  { id: 'post-training', label: 'Post-training' },
  { id: 'system', label: 'System' },
];

const MATURITY: Record<Lever['maturity'], string> = {
  production: 'In production',
  emerging: 'Emerging',
  research: 'Research',
};

function Sources({ sources }: { sources: Source[] }) {
  return (
    <p className="ub-src">
      {sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && ' · '}
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.who} ({s.year})
          </a>
          , {s.title}
        </span>
      ))}
    </p>
  );
}

function Levers() {
  const [tag, setTag] = useState<'all' | LeverTag>('all');
  const [stage, setStage] = useState<'all' | Lever['stage']>('all');
  const shown = useMemo(
    () => LEVERS.filter((l) => (tag === 'all' || l.tags.includes(tag)) && (stage === 'all' || l.stage === stage)),
    [tag, stage],
  );
  return (
    <section id="rs-levers" className="ub-chapter">
      <h2>The levers, and the evidence for each</h2>
      <div className="ub-offers">
        <p>
          {LEVERS.length} changes that make LLMs faster, cheaper or better, from training to serving. Each card says
          what the change does, the gain its source measured and under what conditions, what it costs, and which
          chapters of the book it builds on.
        </p>
      </div>
      <div className="ub-filters">
        <Chips options={TAGS} value={tag} onChange={setTag} />
      </div>
      <div className="ub-filters">
        <Chips options={STAGES} value={stage} onChange={setStage} />
      </div>
      <p className="small muted">{shown.length} shown</p>
      <div className="ub-levers">
        {shown.map((l) => (
          <article key={l.id} className="ub-lever card">
            <h4>{l.name}</h4>
            <div className="ub-tags">
              <span className="ub-tag">{l.stage}</span>
              <span className="ub-tag">{MATURITY[l.maturity]}</span>
              {l.tags.map((t) => (
                <span key={t} className={`ub-tag ${t}`}>
                  {t}
                </span>
              ))}
            </div>
            <p>{l.what}</p>
            <p>
              <span className="ub-gain">Measured gain:</span> {l.gain}
            </p>
            <p>
              <b>Trade-off:</b> {l.tradeoff}
            </p>
            <p className="small muted">
              Builds on chapter{l.chapters.length > 1 ? 's' : ''}{' '}
              {l.chapters.map((n, i) => (
                <span key={n}>
                  {i > 0 && ', '}
                  <a href={`#ch-${n}`}>{n}</a>
                </span>
              ))}
              {l.labs && l.labs.length > 0 && (
                <>
                  {' '}
                  · see{' '}
                  {l.labs.map(([to, label], i) => (
                    <span key={to}>
                      {i > 0 && ', '}
                      <a href={to}>{label}</a>
                    </span>
                  ))}
                </>
              )}
            </p>
            <Sources sources={l.sources} />
          </article>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ what comes next */

function Next() {
  return (
    <section id="rs-frontier" className="ub-chapter">
      <h2>What comes next</h2>
      <div className="ub-offers">
        <p>
          Directions that look likely to shape the next generation of models. Each says what has been shown so far; the
          rest is a bet, and is marked as one.
        </p>
      </div>
      <div className="ub-levers">
        {FRONTIER.map((f) => (
          <article key={f.name} className="ub-lever card">
            <h4>{f.name}</h4>
            <p>{f.why}</p>
            <p>
              <span className="ub-gain">Evidence so far:</span> {f.evidence}
            </p>
            <Sources sources={f.sources} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Reading() {
  return (
    <section id="rs-read" className="ub-chapter">
      <h2>Reading the evidence</h2>
      <div className="ub-llm-grid">
        <div className="ub-llm">
          <b>Gains don&apos;t simply multiply</b>
          <div>
            A 2× from quantisation and a 2× from speculative decoding rarely give 4×. Both attack the same limit, memory
            bandwidth, and once one has removed it the other has less to do. The estimator above shows this when the
            step turns compute-bound.
          </div>
        </div>
        <div className="ub-llm">
          <b>Every number has a condition</b>
          <div>
            A speed-up is measured on one model, one GPU, one batch size and one kind of text. Quality costs are
            measured on chosen benchmarks. Read the condition before you quote the number, and expect less on your own
            workload.
          </div>
        </div>
        <div className="ub-llm">
          <b>Measure on your own task</b>
          <div>
            Before adopting a change, run your evaluation set before and after it (the <a href="/evals">Evals</a> page
            shows how to tell a real gain from noise). A cheaper model that fails your hardest cases is not cheaper.
          </div>
        </div>
        <div className="ub-llm">
          <b>The book gives the reasons</b>
          <div>
            Most of these levers are the book&apos;s ideas applied at scale: quantisation and the KV cache follow from
            the arithmetic of chapter 12, distillation and RL post-training from the losses of chapter 5 and the policy
            gradients of chapter 19, and over-training small models from the generalisation questions of chapter 20.
          </div>
        </div>
      </div>
    </section>
  );
}

/** Part 2 of the page: the what-if estimator, the evidence for each lever, and what comes next. */
export function Research() {
  return (
    <>
      <Estimator />
      <Levers />
      <Next />
      <Reading />
    </>
  );
}
