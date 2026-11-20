/**
 * The illustrative workload behind the effort and cost page, and the arithmetic that prices it.
 *
 * The token counts are a made-up but typical shape, not a measurement: more effort means more thinking on each turn
 * and, for an agent, more turns. Prices are not here; they come from the backend's status (python/common.py), so
 * there is one price list for the whole lab.
 */
import type { Price } from '@/lib/format';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const MODELS = [
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', short: 'Haiku', size: 0.62, defaultEffort: 'medium' as Effort },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', short: 'Sonnet', size: 0.8, defaultEffort: 'high' as Effort },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', short: 'Opus', size: 1, defaultEffort: 'medium' as Effort },
] as const;
export type ModelId = (typeof MODELS)[number]['id'];

export interface Task {
  id: 'simple' | 'agent';
  name: string;
  blurb: string;
  /** System prompt, tool definitions and the request: what the first call sends. */
  input: number;
  /** Thinking tokens on each turn, by effort. */
  thinking: Record<Effort, number>;
  /** Model calls in the task, by effort: an agent at higher effort checks more and calls more tools. */
  turns: Record<Effort, number>;
  /** Each tool call the model writes, and the result that comes back and joins the conversation. */
  toolCall: number;
  toolResult: number;
  /** The final reply. */
  answer: number;
}

export const TASKS: Task[] = [
  {
    id: 'simple',
    name: 'Sort a support email',
    blurb: 'One call: read an email, pick its category and write one line of reasoning.',
    input: 1500,
    thinking: { low: 40, medium: 250, high: 800, xhigh: 1600, max: 3200 },
    turns: { low: 1, medium: 1, high: 1, xhigh: 1, max: 1 },
    toolCall: 0,
    toolResult: 0,
    answer: 80,
  },
  {
    id: 'agent',
    name: 'Fix a failing test',
    blurb: 'An agent loop: read files, run the tests, edit, run them again, then report.',
    input: 7000,
    thinking: { low: 120, medium: 400, high: 900, xhigh: 1500, max: 2500 },
    turns: { low: 3, medium: 4, high: 6, xhigh: 8, max: 11 },
    toolCall: 120,
    toolResult: 1200,
    answer: 450,
  },
];

/** One model call in the run. */
export interface Turn {
  /** Everything sent on this call. On later turns it includes every earlier tool call and result. */
  input: number;
  /** The part of `input` that the previous call already sent, so a cache can serve it. */
  repeated: number;
  thinking: number;
  /** Tool call on every turn but the last; the answer on the last. */
  written: number;
  last: boolean;
}

export function turnsFor(task: Task, effort: Effort): Turn[] {
  const n = task.turns[effort];
  const out: Turn[] = [];
  let input = task.input;
  let previous = 0;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    out.push({
      input,
      repeated: previous,
      thinking: task.thinking[effort],
      written: last ? task.answer : task.toolCall,
      last,
    });
    previous = input;
    input += task.toolCall + task.toolResult; // the call and its result join the conversation for the next request
  }
  return out;
}

export interface Bill {
  inputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  writtenTokens: number;
  /** Dollars, by kind. Thinking and written tokens are both billed as output. */
  input: number;
  cached: number;
  thinking: number;
  written: number;
  total: number;
}

/**
 * Prices a run. With caching, the repeated part of each request is a cache read and the new part a cache write
 * (the write multiplier on the input price). Without it, every input token pays the full input price, every turn.
 */
export function bill(turns: Turn[], price: Price, caching: boolean, writeMultiplier: number): Bill {
  const b: Bill = {
    inputTokens: 0,
    cachedTokens: 0,
    thinkingTokens: 0,
    writtenTokens: 0,
    input: 0,
    cached: 0,
    thinking: 0,
    written: 0,
    total: 0,
  };
  const m = 1e-6;
  for (const t of turns) {
    const fresh = caching ? t.input - t.repeated : t.input;
    const hit = caching ? t.repeated : 0;
    b.inputTokens += fresh;
    b.cachedTokens += hit;
    b.input += fresh * price.input * (caching ? writeMultiplier : 1) * m;
    b.cached += hit * price.cache_read * m;
    b.thinkingTokens += t.thinking;
    b.thinking += t.thinking * price.output * m;
    b.writtenTokens += t.written;
    b.written += t.written * price.output * m;
  }
  b.total = b.input + b.cached + b.thinking + b.written;
  return b;
}

export const tokensOf = (b: Bill) => b.inputTokens + b.cachedTokens + b.thinkingTokens + b.writtenTokens;

/** Dollars for display: enough figures to tell small amounts apart. */
export function usd(x: number): string {
  if (x === 0) return '$0';
  if (x < 0.001) return `$${x.toFixed(5)}`;
  if (x < 0.1) return `$${x.toFixed(4)}`;
  if (x < 100) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString('en-GB')}`;
}
