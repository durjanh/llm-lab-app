/**
 * A simulated conversation filling the context window, under four ways of keeping it in check.
 *
 * The sizes are an illustrative workload, not a measurement, but the mechanics are the real ones: every request sends
 * the whole conversation again; clearing or compacting it changes the start of the conversation, so the cache breaks
 * once; a sub-agent keeps its reading out of the main window but still pays for it. Prices come from the backend's
 * status (python/common.py).
 */

export type Kind = 'prefix' | 'message' | 'result' | 'cleared' | 'summary';
export type Strategy = 'keep' | 'clear' | 'compact' | 'subagent';
export type ScenarioId = 'chat' | 'coding' | 'research';

export interface Block {
  id: number;
  kind: Kind;
  tokens: number;
  label: string;
}

export interface Price {
  input: number;
  output: number;
  cache_read: number;
}

export interface Scenario {
  id: ScenarioId;
  name: string;
  blurb: string;
  prefix: number;
  turns: number;
  /** The user's message and the model's reply on each turn (tokens). */
  message: number;
  reply: number;
  /** Tool results by turn: 0 for a turn without a tool. */
  results: (turn: number, rnd: () => number) => { tokens: number; label: string } | null;
}

/** A small fixed random sequence, so every run of a scenario is the same. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'chat',
    name: 'A chat',
    blurb: 'Questions and answers, no tools: about 600 tokens a turn.',
    prefix: 1500,
    turns: 160,
    message: 120,
    reply: 480,
    results: () => null,
  },
  {
    id: 'coding',
    name: 'A coding agent',
    blurb: 'Reads files, runs tests and searches: each result lands in the conversation.',
    prefix: 6000,
    turns: 140,
    message: 40,
    reply: 220,
    results: (_turn, rnd) => {
      const r = rnd();
      if (r < 0.4) return { tokens: Math.round(2000 + rnd() * 7000), label: 'file read' };
      if (r < 0.7) return { tokens: Math.round(1200 + rnd() * 1800), label: 'test output' };
      return { tokens: Math.round(400 + rnd() * 900), label: 'search' };
    },
  },
  {
    id: 'research',
    name: 'A research agent',
    blurb: 'Fetches web pages and papers: big results, one after another.',
    prefix: 4000,
    turns: 110,
    message: 40,
    reply: 260,
    results: (_turn, rnd) => ({ tokens: Math.round(5000 + rnd() * 11000), label: 'web page' }),
  },
];

export const STRATEGIES: { id: Strategy; name: string; note: string }[] = [
  { id: 'keep', name: 'Keep everything', note: 'Every message and result stays until the window is full.' },
  {
    id: 'clear',
    name: 'Clear old tool results',
    note: 'Past 100K tokens, results older than the last three are cleared, each leaving a short placeholder.',
  },
  {
    id: 'compact',
    name: 'Compact',
    note: 'At 150K tokens (the API default), the conversation is replaced by a summary of about 4,000 tokens.',
  },
  {
    id: 'subagent',
    name: 'Sub-agent reads',
    note: 'A sub-agent reads each result in its own context and sends back a 500-token summary.',
  },
];

export const CLEAR_TRIGGER = 100_000;
export const CLEAR_KEEP = 3;
export const COMPACT_TRIGGER = 150_000;
const SUMMARY = 4000;
const SUB_SUMMARY = 500;
const SUB_PREFIX = 2000;
const PLACEHOLDER = 30;

export interface Step {
  turn: number;
  /** The blocks in the window at the end of the turn: what was sent, then the reply and any tool result. */
  blocks: Block[];
  /** What this turn added (ids), for the animation to fly in. */
  added: number[];
  /** What happened on this turn, if anything worth saying. */
  event: string | null;
  input: number;
  cached: number;
  /** Tokens written to the cache: new content, and everything after an edit. */
  written: number;
  output: number;
  /** Tokens a sub-agent read and wrote outside the main window. */
  subInput: number;
  subOutput: number;
  cost: number;
}

export interface Run {
  steps: Step[];
  /** The turn the window could not take the next request, if it ran out. */
  fullAt: number | null;
  peak: number;
  totalInput: number;
  totalCached: number;
  cost: number;
}

const sum = (b: Block[]) => b.reduce((s, x) => s + x.tokens, 0);

/** Runs a scenario under a strategy, turn by turn. */
export function simulate(
  sc: Scenario,
  strategy: Strategy,
  window: number,
  caching: boolean,
  price: Price | null,
  writeMultiplier: number,
): Run {
  const rnd = seeded(sc.id.length * 7919 + 17);
  const p = price ?? { input: 0, output: 0, cache_read: 0 };
  const m = 1e-6;
  let id = 0;
  let blocks: Block[] = [{ id: id++, kind: 'prefix', tokens: sc.prefix, label: 'system prompt and tools' }];
  // What the last request sent: the cache holds that, not the reply and result added after it.
  let previous: Block[] = [];
  const steps: Step[] = [];
  let fullAt: number | null = null;
  let peak = 0;
  for (let turn = 1; turn <= sc.turns; turn++) {
    const added: number[] = [];
    let event: string | null = null;
    let subInput = 0;
    let subOutput = 0;
    const user: Block = { id: id++, kind: 'message', tokens: sc.message, label: 'your message' };
    blocks = [...blocks, user];
    added.push(user.id);
    // Before the request: the strategy may trim what is already there.
    const size = sum(blocks);
    if (strategy === 'clear' && size > CLEAR_TRIGGER) {
      const results = blocks.filter((b) => b.kind === 'result');
      const old = results.slice(0, Math.max(0, results.length - CLEAR_KEEP));
      if (old.length) {
        const freed = old.reduce((s, b) => s + b.tokens - PLACEHOLDER, 0);
        blocks = blocks.map((b) =>
          old.includes(b) ? { ...b, kind: 'cleared', tokens: PLACEHOLDER, label: 'cleared result' } : b,
        );
        event = `cleared ${old.length} old results, freeing ${Math.round(freed / 1000)}K tokens`;
      }
    }
    let compactCost = 0;
    if (strategy === 'compact' && size > COMPACT_TRIGGER) {
      const before = sum(blocks);
      // Writing the summary is a model call too: it reads the conversation (all but the new message was sent last
      // time, so a cache can serve it) and writes the summary as output.
      const seen = before - user.tokens;
      compactCost =
        ((caching ? seen * p.cache_read + user.tokens * p.input * writeMultiplier : before * p.input) +
          SUMMARY * p.output) *
        m;
      blocks = [
        blocks[0],
        { id: id++, kind: 'summary', tokens: SUMMARY, label: 'summary of the conversation so far' },
        user,
      ];
      event = `compacted ${Math.round(before / 1000)}K tokens into a ${SUMMARY / 1000}K summary`;
    }
    const input = sum(blocks);
    if (input > window) {
      fullAt = turn;
      event = `the request needs ${Math.round(input / 1000)}K tokens: more than the ${Math.round(window / 1000)}K window. It fails.`;
      steps.push({
        turn,
        blocks,
        added,
        event,
        input,
        cached: 0,
        written: 0,
        output: 0,
        subInput: 0,
        subOutput: 0,
        cost: 0,
      });
      break;
    }
    peak = Math.max(peak, input);
    // The cache can serve only the blocks this request shares, unchanged and in order, with the last one.
    let cached = 0;
    if (caching) {
      for (let i = 0; i < Math.min(previous.length, blocks.length); i++) {
        const a = previous[i];
        const b = blocks[i];
        if (a.id !== b.id || a.tokens !== b.tokens || a.kind !== b.kind) break;
        cached += b.tokens;
      }
    }
    const written = caching ? input - cached : 0;
    const output = sc.reply;
    let cost =
      compactCost +
      (caching ? cached * p.cache_read + written * p.input * writeMultiplier : input * p.input) * m +
      output * p.output * m;
    // The model's reply, then a tool result if this turn uses one.
    previous = blocks;
    const reply: Block = { id: id++, kind: 'message', tokens: sc.reply, label: 'model reply and tool call' };
    blocks = [...blocks, reply];
    added.push(reply.id);
    const r = sc.results(turn, rnd);
    if (r) {
      if (strategy === 'subagent') {
        subInput = SUB_PREFIX + r.tokens;
        subOutput = SUB_SUMMARY;
        cost += (subInput * p.input + subOutput * p.output) * m;
        const s: Block = {
          id: id++,
          kind: 'summary',
          tokens: SUB_SUMMARY,
          label: `sub-agent's summary of a ${r.label}`,
        };
        blocks = [...blocks, s];
        added.push(s.id);
      } else {
        const b: Block = { id: id++, kind: 'result', tokens: r.tokens, label: r.label };
        blocks = [...blocks, b];
        added.push(b.id);
      }
    }
    steps.push({ turn, blocks, added, event, input, cached, written, output, subInput, subOutput, cost });
  }
  // A request that does not fit is never answered, so it is neither sent nor billed.
  const answered = steps.filter((x) => x.turn !== fullAt);
  const totalInput = answered.reduce((s, x) => s + x.input + x.subInput, 0);
  const totalCached = answered.reduce((s, x) => s + x.cached, 0);
  return { steps, fullAt, peak, totalInput, totalCached, cost: steps.reduce((s, x) => s + x.cost, 0) };
}

export const k = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(x % 1e6 ? 2 : 0)}M` : `${Math.round(x / 1000)}K`);
export const n0 = (x: number) => Math.round(x).toLocaleString('en-GB');
export function usd(x: number): string {
  if (x === 0) return '$0';
  if (x < 0.01) return `$${x.toFixed(4)}`;
  if (x < 100) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString('en-GB')}`;
}
