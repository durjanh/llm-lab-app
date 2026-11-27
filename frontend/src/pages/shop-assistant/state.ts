/* The chat widget's state, kept free of React so it can be tested: messages built from the stream's events, the
   pieces each reply carries (products, a comparison, a question with quick replies, a confirmation, an order), the
   activity log, the basket the agent last reported, and the context the chat sends about where the shopper is. */
import type { Basket, ChatContext, Comparison, Confirmation, Order, Product, ShopEvent } from '@/services/shopService';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'products'; items: Product[] }
  | { kind: 'comparison'; comparison: Comparison }
  | {
      kind: 'question';
      questionId: string;
      question: string;
      options: string[];
      /** The quick reply the shopper chose, once answered; the chips are then shown as used. */
      answered: string | null;
    }
  | { kind: 'confirmation'; confirmation: Confirmation; state: 'pending' | 'accepted' | 'cancelled' | 'failed' }
  | { kind: 'order'; order: Order };

export interface ActivityRow {
  time: number;
  title: string;
  detail?: string;
  tone: 'call' | 'tool' | 'ok' | 'bad' | 'route' | 'cost';
}

export interface UserMessage {
  role: 'user';
  id: string;
  text: string;
  attachments: string[];
  time: number;
}

export interface BotMessage {
  role: 'bot';
  id: string;
  blocks: Block[];
  time: number;
  /** True while the stream for this reply is open. */
  live: boolean;
  cached: boolean;
  model: string | null;
  routeReason: string | null;
  error: string | null;
  stopped: string | null;
  costUsd: number;
  activity: ActivityRow[];
}

export type Message = UserMessage | BotMessage;

export interface ChatState {
  messages: Message[];
  /** The server's conversation for this shopper, sent with the next message so the agent remembers. */
  sessionId: string | null;
  runId: string | null;
  running: boolean;
  /** The basket as the agent last reported it, for the header and the drawer. */
  basket: Basket | null;
  /** Bumped whenever an action may have changed the shopper's orders or wish list, so panels reload. */
  changes: number;
}

export const EMPTY_CHAT: ChatState = {
  messages: [],
  sessionId: null,
  runId: null,
  running: false,
  basket: null,
  changes: 0,
};

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Adds the shopper's message and an empty reply that the stream will fill. */
export function startTurn(state: ChatState, text: string, attachments: string[] = [], now = Date.now()): ChatState {
  const user: UserMessage = { role: 'user', id: nextId('u'), text, attachments, time: now };
  const bot: BotMessage = {
    role: 'bot',
    id: nextId('b'),
    blocks: [],
    time: now,
    live: true,
    cached: false,
    model: null,
    routeReason: null,
    error: null,
    stopped: null,
    costUsd: 0,
    activity: [],
  };
  return { ...state, messages: [...state.messages, user, bot], running: true, runId: null };
}

const short = (v: unknown, n = 140) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function withLastBot(state: ChatState, change: (m: BotMessage) => BotMessage): ChatState {
  const i = state.messages.length - 1;
  const last = state.messages[i];
  if (!last || last.role !== 'bot' || !last.live) return state; // events after the reply ended are ignored
  const messages = state.messages.slice();
  messages[i] = change(last);
  return { ...state, messages };
}

const addBlock = (m: BotMessage, block: Block): BotMessage => ({ ...m, blocks: [...m.blocks, block] });
const log = (m: BotMessage, row: Omit<ActivityRow, 'time'>, now: number): BotMessage => ({
  ...m,
  activity: [...m.activity, { ...row, time: now }],
});

/** One stream event applied to the chat. Unknown events, and events after the reply has ended, change nothing. */
export function reduce(state: ChatState, e: ShopEvent, now = Date.now()): ChatState {
  switch (e.type) {
    case 'run':
      return { ...state, runId: e.run_id };
    case 'session':
      return { ...state, sessionId: e.session_id };
    case 'turn':
      return e.session_id ? { ...state, sessionId: e.session_id } : state;
    case 'text':
      if (e.agent && e.agent !== 'main') return state;
      return withLastBot(state, (m) => {
        const last = m.blocks[m.blocks.length - 1];
        if (last?.kind === 'text') {
          const blocks = m.blocks.slice(0, -1);
          return { ...m, blocks: [...blocks, { kind: 'text', text: last.text + e.delta }] };
        }
        return addBlock(m, { kind: 'text', text: e.delta });
      });
    case 'model_call':
      return withLastBot(state, (m) =>
        log(
          { ...m, model: e.model },
          { tone: 'call', title: `Model call: ${e.model}${e.effort ? `, ${e.effort}` : ''}` },
          now,
        ),
      );
    case 'route':
      return withLastBot(state, (m) =>
        log(
          { ...m, model: e.model, routeReason: e.reason ?? null },
          { tone: 'route', title: `Auto chose ${e.model}${e.tier ? ` (${e.tier})` : ''}`, detail: e.reason },
          now,
        ),
      );
    case 'tool_call':
      return withLastBot(state, (m) => log(m, { tone: 'tool', title: e.name, detail: short(e.input, 400) }, now));
    case 'tool_result':
      return withLastBot(state, (m) =>
        log(
          m,
          { tone: e.ok ? 'ok' : 'bad', title: e.ok ? 'Done' : 'Refused or failed', detail: short(e.output, 400) },
          now,
        ),
      );
    case 'usage':
      return withLastBot(state, (m) =>
        log(
          { ...m, costUsd: e.run_cost_usd ?? m.costUsd + (e.cost_usd ?? 0) },
          {
            tone: 'cost',
            title: `${(e.input_tokens ?? 0).toLocaleString('en-GB')} in, ${(e.output_tokens ?? 0).toLocaleString('en-GB')} out`,
            detail: e.cost_usd !== undefined ? `$${e.cost_usd.toFixed(4)}` : undefined,
          },
          now,
        ),
      );
    case 'products':
      return withLastBot(state, (m) => (e.items.length ? addBlock(m, { kind: 'products', items: e.items }) : m));
    case 'comparison':
      return withLastBot(state, (m) =>
        addBlock(m, { kind: 'comparison', comparison: { products: e.products, rows: e.rows } }),
      );
    case 'question':
      return withLastBot(state, (m) =>
        addBlock(m, {
          kind: 'question',
          questionId: e.question_id,
          question: e.question,
          options: e.options.slice(0, 5),
          answered: null,
        }),
      );
    case 'confirmation':
      return withLastBot(state, (m) =>
        addBlock(m, {
          kind: 'confirmation',
          confirmation: { confirmation_id: e.confirmation_id, kind: e.kind, summary: e.summary ?? {} },
          state: 'pending',
        }),
      );
    case 'order':
      return {
        ...withLastBot(state, (m) => addBlock(m, { kind: 'order', order: e.order })),
        changes: state.changes + 1,
      };
    case 'basket': {
      // The basket can arrive after the reply ended (a confirmation), so it updates the shop either way.
      const next = withLastBot(state, (m) => log(m, { tone: 'ok', title: 'Basket updated' }, now));
      return { ...next, basket: e.basket, changes: state.changes + 1 };
    }
    case 'cached':
      return withLastBot(state, (m) => ({ ...m, cached: true }));
    case 'error':
      return withLastBot(state, (m) =>
        log({ ...m, error: e.message }, { tone: 'bad', title: 'Error', detail: e.message }, now),
      );
    case 'done': {
      const next = withLastBot(state, (m) => {
        let blocks = m.blocks;
        // A reply that streamed no text but ended with some (a cached answer) shows that text.
        if (e.text && !m.blocks.some((b) => b.kind === 'text')) blocks = [{ kind: 'text', text: e.text }, ...blocks];
        return {
          ...m,
          blocks,
          live: false,
          stopped: e.stopped ?? 'finished',
          costUsd: e.cost_usd ?? m.costUsd,
        };
      });
      return { ...next, running: false, runId: null };
    }
    default:
      return state;
  }
}

/** Ends the open reply when the stream stops without a "done": the connection dropped, or the shopper pressed Stop. */
export function endTurn(state: ChatState, reason: 'stopped' | 'error', message?: string): ChatState {
  const next = withLastBot(state, (m) => ({
    ...m,
    live: false,
    stopped: reason,
    error: m.error ?? (reason === 'error' ? (message ?? 'The reply stopped before it finished.') : null),
  }));
  return { ...next, running: false, runId: null };
}

/** Marks a question as answered with the chip the shopper chose; a second answer to the same question is ignored. */
export function answerQuestion(state: ChatState, questionId: string, choice: string): ChatState {
  let changed = false;
  const messages = state.messages.map((m) => {
    if (m.role !== 'bot') return m;
    const blocks = m.blocks.map((b) => {
      if (b.kind === 'question' && b.questionId === questionId && b.answered === null) {
        changed = true;
        return { ...b, answered: choice };
      }
      return b;
    });
    return changed ? { ...m, blocks } : m;
  });
  return changed ? { ...state, messages } : state;
}

/** The latest question still waiting for an answer, if any: a chip sends its text as the next message. */
export function openQuestion(state: ChatState): Extract<Block, { kind: 'question' }> | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role !== 'bot') continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.kind === 'question') return b.answered === null ? b : null;
    }
    return null;
  }
  return null;
}

/** Records the outcome of a confirmation card (Confirm or Cancel pressed, or the call failed). */
export function settleConfirmation(
  state: ChatState,
  confirmationId: string,
  outcome: 'accepted' | 'cancelled' | 'failed',
): ChatState {
  return {
    ...state,
    changes: state.changes + 1,
    messages: state.messages.map((m) =>
      m.role !== 'bot'
        ? m
        : {
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === 'confirmation' && b.confirmation.confirmation_id === confirmationId && b.state === 'pending'
                ? { ...b, state: outcome }
                : b,
            ),
          },
    ),
  };
}

/** Where the shopper is in the shop, as the chat sends it. A product id is only sent while a product is open. */
export function chatContext(view: View, activitySummary?: unknown): ChatContext {
  const extra = activitySummary ? { activity_summary: activitySummary } : {};
  switch (view.kind) {
    case 'product':
      return { page: 'product', viewing_product_id: view.id, ...extra };
    case 'search':
      return { page: 'search', ...extra };
    case 'account':
      return { page: 'account', ...extra };
    case 'basket':
      return { page: 'basket', ...extra };
    default:
      return { page: 'home', ...extra };
  }
}

/** The page name an activity event records for a view. */
export const pageName = (view: View) => (view.kind === 'lab' ? 'home' : chatContext(view).page);

/** The shop's own screens. */
export type View =
  | { kind: 'home' }
  | { kind: 'search'; query: string; category?: string }
  | { kind: 'product'; id: string }
  | { kind: 'account'; tab: AccountTab }
  | { kind: 'basket' }
  | { kind: 'lab' };

/** Pence as pounds: "£1,234.50"; whole pounds keep their pence (£12.00) so prices line up. */
export function money(pence: number | undefined | null): string {
  const p = Number.isFinite(pence) ? Number(pence) : 0;
  return `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The number of items in a basket, counting quantities. */
export const basketCount = (b: Basket | null | undefined) => (b?.items ?? []).reduce((n, i) => n + i.quantity, 0);

/** Normalises the orders route's answer, which may be a list or an object with orders and returns. */
export function asList<T>(v: T[] | { [k: string]: unknown } | null | undefined, key: string): T[] {
  if (Array.isArray(v)) return v;
  const inner = v?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

/** The account area's tabs. */
export type AccountTab = 'orders' | 'returns' | 'wishlist' | 'profile';

/**
 * A quick-reply chip pressed: marks its question answered and starts a turn with the chip's text, or null when that
 * question is already answered (or gone), so a second tap sends nothing.
 */
export function chipReply(state: ChatState, questionId: string, choice: string, now = Date.now()): ChatState | null {
  if (state.running) return null;
  const answered = answerQuestion(state, questionId, choice);
  if (answered === state) return null;
  return startTurn(answered, choice, [], now);
}
