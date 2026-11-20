/**
 * A conversation sent turn by turn, with and without prompt caching.
 *
 * The rules are the API's: every request sends the whole conversation; the server reuses its stored work for the
 * longest exact match from the start (tools, then system prompt, then messages) if the entry is still alive; a read
 * renews the entry's five minutes; the rest is written to the cache at 1.25x the input price; output is never cached.
 * The token counts are an illustrative conversation. Prices come from the backend's status (python/common.py).
 */
import type { Price } from '@/lib/format';

export type Kind = 'tools' | 'system' | 'user' | 'reply' | 'document';

export interface Block {
  id: string;
  kind: Kind;
  label: string;
  tokens: number;
}

/** The conversation's turns: what the person sends, and how long the reply is. */
export const TURNS: { user: Block; reply: number }[] = [
  { user: { id: 'u1', kind: 'user', label: 'Can you review our refund policy?', tokens: 120 }, reply: 260 },
  { user: { id: 'u2', kind: 'document', label: 'Here it is (a 6-page policy)', tokens: 6400 }, reply: 900 },
  { user: { id: 'u3', kind: 'user', label: 'Which parts are unclear?', tokens: 90 }, reply: 700 },
  { user: { id: 'u4', kind: 'user', label: 'Rewrite section 3 more simply', tokens: 110 }, reply: 1100 },
  { user: { id: 'u5', kind: 'user', label: 'Now a short version for customers', tokens: 140 }, reply: 600 },
  { user: { id: 'u6', kind: 'user', label: 'Translate that into Welsh', tokens: 80 }, reply: 650 },
];

export const PREFIX: Block[] = [
  { id: 'tools', kind: 'tools', label: 'tool definitions', tokens: 2100 },
  { id: 'system', kind: 'system', label: 'system prompt', tokens: 3200 },
];

/** Minutes between one request and the next, in the story. */
export const GAP_MINUTES = 1.5;
export const TTL_MINUTES = 5;

export interface Event {
  /** Change the system prompt before this request. */
  editSystem?: boolean;
  /** Minutes the person waits before this request. */
  wait?: number;
}

export interface Request {
  turn: number;
  /** Minutes into the story when it starts. */
  at: number;
  blocks: Block[];
  total: number;
  /** Tokens from the start that matched the cache and were read from it. */
  read: number;
  /** Tokens written to the cache: everything after the read point. */
  written: number;
  /** Tokens processed and not cached (all of them when caching is off). */
  uncached: number;
  output: number;
  /** Why the cache missed, if it did. */
  miss: 'first' | 'expired' | 'changed' | 'off' | null;
  /** The index of the first block that did not match. */
  matchUntil: number;
  /** Minutes left on the cache entry when this request starts (before it renews it). */
  ttlLeft: number | null;
  cost: number;
  costWithout: number;
}

const sum = (b: Block[]) => b.reduce((s, x) => s + x.tokens, 0);

/**
 * Whose rules: Anthropic's (Claude, also on Microsoft Foundry), or Azure OpenAI's for GPT models before GPT-5.6:
 * always on, only from 1,024 tokens, matched in 128-token steps after that, and nothing extra to write.
 */
export type Rules = 'anthropic' | 'azure';
export const AZURE_MIN = 1024;
export const AZURE_STEP = 128;

/** Azure counts a hit as the first 1,024 tokens, then whole 128-token steps of the matching start. */
export const azureCached = (matched: number) =>
  matched < AZURE_MIN ? 0 : AZURE_MIN + Math.floor((matched - AZURE_MIN) / AZURE_STEP) * AZURE_STEP;

/** Plays the conversation through, request by request. */
export function simulate(
  caching: boolean,
  events: Record<number, Event>,
  price: Price | null,
  writeMultiplier: number,
  rules: Rules = 'anthropic',
): Request[] {
  const azure = rules === 'azure';
  if (azure) caching = true; // Azure caches supported models automatically; there is no switch
  const p = price ?? { input: 0, output: 0, cache_read: 0 };
  const m = 1e-6;
  let prefix = PREFIX.map((b) => ({ ...b }));
  const history: Block[] = [];
  let cached: Block[] | null = null; // what the cache holds: the blocks of the last request, in order
  let cachedAt = -Infinity; // when the entry was last written or read
  let clock = 0;
  const out: Request[] = [];
  TURNS.forEach((t, i) => {
    const ev = events[i] ?? {};
    if (i > 0) clock += GAP_MINUTES + (ev.wait ?? 0);
    if (ev.editSystem)
      prefix = prefix.map((b) =>
        b.kind === 'system' ? { ...b, id: `system-${i}`, label: 'system prompt (edited)' } : b,
      );
    const blocks = [...prefix, ...history, t.user];
    const total = sum(blocks);
    const ttlLeft = cached ? Math.max(0, TTL_MINUTES - (clock - cachedAt)) : null;
    let matchUntil = 0;
    let miss: Request['miss'] = null;
    if (!caching) miss = 'off';
    else if (!cached) miss = 'first';
    else if (clock - cachedAt > TTL_MINUTES) miss = 'expired';
    else {
      while (matchUntil < Math.min(cached.length, blocks.length) && cached[matchUntil].id === blocks[matchUntil].id)
        matchUntil++;
      if (matchUntil < Math.min(cached.length, blocks.length)) miss = 'changed';
    }
    if (miss === 'expired' || miss === 'first' || miss === 'off') matchUntil = 0;
    const matched = sum(blocks.slice(0, matchUntil));
    const read = azure ? azureCached(matched) : matched;
    // Anthropic bills the rest as a cache write; Azure (before GPT-5.6) bills it as ordinary input, with no write charge.
    const written = caching && !azure ? total - read : 0;
    const uncached = !caching || azure ? total - read : 0;
    const output = t.reply;
    const cost =
      (read * p.cache_read + written * p.input * writeMultiplier + uncached * p.input + output * p.output) * m;
    const costWithout = (total * p.input + output * p.output) * m;
    out.push({
      turn: i + 1,
      at: clock,
      blocks,
      total,
      read,
      written,
      uncached,
      output,
      miss,
      matchUntil,
      ttlLeft,
      cost,
      costWithout,
    });
    if (caching) {
      cached = blocks;
      cachedAt = clock; // writing or reading renews the entry
    }
    history.push(t.user, { id: `r${i + 1}`, kind: 'reply', label: 'reply', tokens: t.reply });
  });
  return out;
}

export function usd(x: number): string {
  if (x === 0) return '$0';
  if (x < 0.01) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(3)}`;
}
