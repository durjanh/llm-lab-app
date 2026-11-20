/**
 * The arithmetic of answering: how much work a model does per token, and roughly how much energy that takes.
 *
 * Model sizes are the published figures of open models (closed models such as Claude and GPT do not publish theirs).
 * The energy figures are estimates from a GPU's datasheet and stated assumptions, not measurements: they show how the
 * cost scales with size and batching, which is the point, not the exact watt-hours of any provider.
 */

export interface ModelSpec {
  id: string;
  name: string;
  /** Parameters in total, and those used for each token (the same for a dense model). */
  total: number;
  active: number;
  layers: number;
  /** How many numbers stand for each token inside the model. */
  width: number;
  /** Tokens it was trained on, where published. */
  trainedOn: number | null;
  note: string;
}

export const MODELS: ModelSpec[] = [
  {
    id: 'gpt2',
    name: 'GPT-2 small',
    total: 124e6,
    active: 124e6,
    layers: 12,
    width: 768,
    trainedOn: null,
    note: 'OpenAI, 2019. Small enough to run in your browser on the transformer page.',
  },
  {
    id: 'llama8',
    name: 'Llama 3.1 8B',
    total: 8.03e9,
    active: 8.03e9,
    layers: 32,
    width: 4096,
    trainedOn: 15e12,
    note: 'Meta, 2024. Fits on one GPU, or a laptop when quantised.',
  },
  {
    id: 'llama70',
    name: 'Llama 3.1 70B',
    total: 70.6e9,
    active: 70.6e9,
    layers: 80,
    width: 8192,
    trainedOn: 15e12,
    note: 'Meta, 2024. Its weights alone are 141 GB in 16-bit numbers: more than one 80 GB GPU holds.',
  },
  {
    id: 'llama405',
    name: 'Llama 3.1 405B',
    total: 405e9,
    active: 405e9,
    layers: 126,
    width: 16384,
    trainedOn: 15.6e12,
    note: 'Meta, 2024. Every one of its 405 billion parameters is used for every token.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek-V3',
    total: 671e9,
    active: 37e9,
    layers: 61,
    width: 7168,
    trainedOn: 14.8e12,
    note: 'DeepSeek, 2024. A mixture of experts: 671 billion parameters, of which about 37 billion work on each token.',
  },
];

/** NVIDIA H100 SXM, from its datasheet: dense BF16 throughput, memory, memory speed and maximum power. */
export const GPU = { name: 'NVIDIA H100 (SXM)', flops: 989e12, memory: 80e9, bandwidth: 3.35e12, watts: 700 };
/** Weights in 16-bit numbers take two bytes each; a fifth more memory is kept free for the conversation (KV cache). */
const BYTES_PER_PARAM = 2;
const HEADROOM = 1.2;

export interface Assumptions {
  /** The share of the GPU's top speed that real work reaches. */
  utilisation: number;
  /** How many people's tokens the server works on at once. */
  batch: number;
}

/** GPUs needed just to hold the weights. */
export const gpusFor = (m: ModelSpec) => Math.max(1, Math.ceil((m.total * BYTES_PER_PARAM * HEADROOM) / GPU.memory));

/** Multiply-adds for one token through the model, counted as two operations each (multiply, then add). */
export const opsPerToken = (m: ModelSpec) => 2 * m.active;

/**
 * Energy (joules) to write one token of an answer. Each step must read the weights it uses from memory, and that read
 * is shared by everyone in the batch; the arithmetic is not. Whichever takes longer sets the time, and the GPUs draw
 * their power for that long. The number of GPUs cancels out: more GPUs share the work and the power alike.
 */
export function joulesPerToken(m: ModelSpec, a: Assumptions): { joules: number; memoryBound: boolean } {
  const compute = opsPerToken(m) / (GPU.flops * a.utilisation);
  // For a mixture of experts this reads only the active experts: a best case, since a batch's tokens use more of them.
  const memory = (m.active * BYTES_PER_PARAM) / (GPU.bandwidth * a.batch);
  return { joules: GPU.watts * Math.max(compute, memory), memoryBound: memory > compute };
}

/** Energy (joules) to read the prompt: all its tokens go through at once, so the arithmetic sets the pace. */
export const joulesForPrompt = (m: ModelSpec, tokens: number, a: Assumptions) =>
  (GPU.watts * 2 * m.active * tokens) / (GPU.flops * a.utilisation);

/** Training compute: about six operations per parameter per training token (forward and backward passes). */
export const trainingOps = (m: ModelSpec) => (m.trainedOn ? 6 * m.active * m.trainedOn : null);
export const trainingGpuHours = (m: ModelSpec, utilisation: number) => {
  const ops = trainingOps(m);
  return ops ? ops / (GPU.flops * utilisation) / 3600 : null;
};

export const wh = (joules: number) => joules / 3600;

export function big(x: number): string {
  const units: [number, string][] = [
    [1e24, ' septillion'],
    [1e21, ' sextillion'],
    [1e18, ' quintillion'],
    [1e15, ' quadrillion'],
    [1e12, ' trillion'],
    [1e9, ' billion'],
    [1e6, ' million'],
    [1e3, ' thousand'],
  ];
  // Three significant figures: 15.6 trillion, not 16.
  for (const [v, name] of units) if (x >= v) return `${Number((x / v).toPrecision(3)).toLocaleString('en-GB')}${name}`;
  return Math.round(x).toLocaleString('en-GB');
}

export const params = (x: number) => (x >= 1e9 ? `${Number((x / 1e9).toPrecision(3))}B` : `${Math.round(x / 1e6)}M`);

/** Energy for display, from joules: J, then Wh and kWh as it grows. */
export function energy(joules: number): string {
  const w = wh(joules);
  if (joules < 0.1) return `${Number((joules * 1000).toPrecision(2))} mJ`;
  if (w < 0.01) return `${joules.toFixed(joules < 1 ? 2 : 1)} J`;
  if (w < 1000) return `${w.toFixed(w < 1 ? 3 : 1)} Wh`;
  if (w < 1e6) return `${(w / 1000).toFixed(1)} kWh`;
  if (w < 1e9) return `${(w / 1e6).toFixed(1)} MWh`;
  return `${(w / 1e9).toFixed(1)} GWh`;
}
