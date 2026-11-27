import { describe, expect, it } from 'vitest';
import type { Basket, Product, ShopEvent } from '@/services/shopService';
import {
  answerQuestion,
  basketCount,
  chatContext,
  chipReply,
  EMPTY_CHAT,
  endTurn,
  money,
  openQuestion,
  reduce,
  settleConfirmation,
  startTurn,
  type BotMessage,
  type ChatState,
} from './state';

const product = (id: string, extra: Partial<Product> = {}): Product => ({
  id,
  title: `Product ${id}`,
  brand: 'Fernhill',
  category: 'Outdoor',
  price_pence: 4999,
  stock: 3,
  ...extra,
});
const basket: Basket = {
  items: [{ id: 'i1', product_id: 'p1', title: 'Boots', quantity: 2, unit_price_pence: 5000 }],
  subtotal_pence: 10000,
  total_pence: 10000,
};

const play = (events: ShopEvent[], from: ChatState = startTurn(EMPTY_CHAT, 'hello', [], 1)) =>
  events.reduce((s, e) => reduce(s, e, 2), from);
const bot = (s: ChatState) => s.messages[s.messages.length - 1] as BotMessage;

describe('startTurn', () => {
  it('adds the message and an empty live reply, and marks the chat running', () => {
    const s = startTurn(EMPTY_CHAT, 'boots', ['a.png'], 5);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: 'user', text: 'boots', attachments: ['a.png'], time: 5 });
    expect(bot(s)).toMatchObject({ role: 'bot', live: true, blocks: [] });
    expect(s.running).toBe(true);
  });
});

describe('reduce', () => {
  it('keeps the run, session and turn ids', () => {
    const s = play([
      { type: 'run', run_id: 'r1' },
      { type: 'session', session_id: 's1' },
    ]);
    expect(s.runId).toBe('r1');
    expect(s.sessionId).toBe('s1');
    expect(play([{ type: 'turn', turn_id: 't', session_id: 's2' }]).sessionId).toBe('s2');
    expect(play([{ type: 'turn', turn_id: 't' }], { ...startTurn(EMPTY_CHAT, 'x'), sessionId: 'keep' }).sessionId).toBe(
      'keep',
    );
  });

  it('joins text deltas into one block and ignores helper agents', () => {
    const s = play([
      { type: 'text', delta: 'Hello ' },
      { type: 'text', agent: 'main', delta: 'there' },
      { type: 'text', agent: 'router', delta: 'IGNORED' },
    ]);
    expect(bot(s).blocks).toEqual([{ kind: 'text', text: 'Hello there' }]);
  });

  it('logs model calls, routing, tools and usage for Show work', () => {
    const s = play([
      { type: 'model_call', model: 'claude-haiku-5-5', effort: 'low' },
      { type: 'route', model: 'claude-sonnet-5-5', tier: 'mid', reason: 'a comparison' },
      { type: 'tool_call', id: 't1', name: 'search_products', input: { query: 'boots' } },
      { type: 'tool_result', id: 't1', ok: true, output: '3 found' },
      { type: 'tool_result', id: 't2', ok: false, output: 'refused' },
      { type: 'usage', model: 'claude-sonnet-5-5', input_tokens: 1200, output_tokens: 80, cost_usd: 0.002 },
    ]);
    const m = bot(s);
    expect(m.model).toBe('claude-sonnet-5-5');
    expect(m.routeReason).toBe('a comparison');
    expect(m.activity.map((a) => a.tone)).toEqual(['call', 'route', 'tool', 'ok', 'bad', 'cost']);
    expect(m.activity[2].detail).toContain('boots');
    expect(m.costUsd).toBeCloseTo(0.002);
  });

  it('adds products, but not an empty list', () => {
    const s = play([
      { type: 'products', items: [] },
      { type: 'products', items: [product('p1'), product('p2')] },
    ]);
    expect(bot(s).blocks).toEqual([{ kind: 'products', items: [product('p1'), product('p2')] }]);
  });

  it('adds a comparison table', () => {
    const s = play([
      { type: 'comparison', products: [{ id: 'a', title: 'A' }], rows: [{ attribute: 'Weight', values: ['1kg'] }] },
    ]);
    expect(bot(s).blocks[0]).toEqual({
      kind: 'comparison',
      comparison: { products: [{ id: 'a', title: 'A' }], rows: [{ attribute: 'Weight', values: ['1kg'] }] },
    });
  });

  it('adds a question with at most five options, unanswered', () => {
    const s = play([
      { type: 'question', question_id: 'q1', question: 'Who is it for?', options: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ]);
    expect(bot(s).blocks[0]).toEqual({
      kind: 'question',
      questionId: 'q1',
      question: 'Who is it for?',
      options: ['a', 'b', 'c', 'd', 'e'],
      answered: null,
    });
  });

  it('adds a pending confirmation card', () => {
    const s = play([{ type: 'confirmation', confirmation_id: 'c1', kind: 'checkout', summary: { total_pence: 1000 } }]);
    expect(bot(s).blocks[0]).toMatchObject({ kind: 'confirmation', state: 'pending' });
  });

  it('adds an order and asks the panels to reload', () => {
    const order = { id: 'o1', created_at: '2026-11-26', status: 'placed', total_pence: 1, items: [] };
    const s = play([{ type: 'order', order }]);
    expect(bot(s).blocks[0]).toEqual({ kind: 'order', order });
    expect(s.changes).toBe(1);
  });

  it('updates the basket, even after the reply has ended', () => {
    const s = play([{ type: 'basket', basket }]);
    expect(s.basket).toBe(basket);
    expect(s.changes).toBe(1);
    const after = reduce(play([{ type: 'done' }]), { type: 'basket', basket });
    expect(after.basket).toBe(basket);
    expect(after.changes).toBe(1);
  });

  it('marks a saved answer', () => {
    expect(bot(play([{ type: 'cached' }])).cached).toBe(true);
  });

  it('shows an error inline', () => {
    const m = bot(play([{ type: 'error', message: 'The model is busy.' }]));
    expect(m.error).toBe('The model is busy.');
    expect(m.activity.at(-1)?.tone).toBe('bad');
  });

  it('ends the reply on done, using its text when nothing streamed', () => {
    const s = play([{ type: 'cached' }, { type: 'done', text: 'From the cache', cost_usd: 0 }]);
    expect(s.running).toBe(false);
    expect(bot(s)).toMatchObject({
      live: false,
      stopped: 'finished',
      blocks: [{ kind: 'text', text: 'From the cache' }],
    });
    const streamed = play([
      { type: 'text', delta: 'Live' },
      { type: 'done', text: 'ignored' },
    ]);
    expect(bot(streamed).blocks).toEqual([{ kind: 'text', text: 'Live' }]);
  });

  it('ignores events after the reply ended, and unknown events', () => {
    const done = play([{ type: 'text', delta: 'Hi' }, { type: 'done' }]);
    const later = play(
      [
        { type: 'text', delta: ' more' },
        { type: 'products', items: [product('p9')] },
      ],
      done,
    );
    expect(bot(later).blocks).toEqual([{ kind: 'text', text: 'Hi' }]);
    expect(reduce(done, { type: 'nonsense' } as unknown as ShopEvent)).toBe(done);
  });
});

describe('endTurn', () => {
  it('stops the reply without an error when the shopper pressed Stop', () => {
    const s = endTurn(play([{ type: 'text', delta: 'Half' }]), 'stopped');
    expect(s.running).toBe(false);
    expect(bot(s)).toMatchObject({ live: false, stopped: 'stopped', error: null });
  });

  it('says the reply was cut off when the stream dropped', () => {
    const s = endTurn(startTurn(EMPTY_CHAT, 'x'), 'error');
    expect(bot(s).error).toMatch(/stopped before it finished/);
    expect(bot(endTurn(startTurn(EMPTY_CHAT, 'x'), 'error', 'Network down')).error).toBe('Network down');
  });

  it('keeps an error the stream already gave', () => {
    const s = endTurn(play([{ type: 'error', message: 'Refused' }]), 'error', 'other');
    expect(bot(s).error).toBe('Refused');
  });
});

describe('quick-reply chips', () => {
  const asked = play([
    { type: 'question', question_id: 'q1', question: 'Budget?', options: ['Under £50', 'Under £100'] },
    { type: 'done' },
  ]);

  it('finds the open question', () => {
    expect(openQuestion(asked)?.questionId).toBe('q1');
    expect(openQuestion(EMPTY_CHAT)).toBeNull();
  });

  it('a chip marks its question answered and sends its text as the next message', () => {
    const s = chipReply(asked, 'q1', 'Under £50', 9);
    expect(s).not.toBeNull();
    const q = (s!.messages[1] as BotMessage).blocks[0];
    expect(q).toMatchObject({ kind: 'question', answered: 'Under £50' });
    expect(s!.messages.at(-2)).toMatchObject({ role: 'user', text: 'Under £50' });
    expect(s!.running).toBe(true);
    expect(openQuestion(s!)).toBeNull();
  });

  it('a second tap, or a tap while a reply runs, sends nothing', () => {
    const once = answerQuestion(asked, 'q1', 'Under £50');
    expect(answerQuestion(once, 'q1', 'Under £100')).toBe(once);
    expect(chipReply(once, 'q1', 'Under £100')).toBeNull();
    expect(chipReply({ ...asked, running: true }, 'q1', 'Under £50')).toBeNull();
    expect(chipReply(asked, 'missing', 'x')).toBeNull();
  });

  it('free text after a question still works and leaves the chips unanswered', () => {
    const s = startTurn(asked, 'about £70');
    expect((s.messages[1] as BotMessage).blocks[0]).toMatchObject({ answered: null });
  });
});

describe('settleConfirmation', () => {
  it('settles only the pending card it names', () => {
    const s = play([
      { type: 'confirmation', confirmation_id: 'c1', kind: 'checkout', summary: {} },
      { type: 'confirmation', confirmation_id: 'c2', kind: 'return', summary: {} },
    ]);
    const after = settleConfirmation(s, 'c1', 'accepted');
    expect(bot(after).blocks.map((b) => (b.kind === 'confirmation' ? b.state : ''))).toEqual(['accepted', 'pending']);
    const again = settleConfirmation(after, 'c1', 'cancelled');
    expect(bot(again).blocks[0]).toMatchObject({ state: 'accepted' });
  });
});

describe('chatContext', () => {
  it('names the page and sends a product id only while a product is open', () => {
    expect(chatContext({ kind: 'home' })).toEqual({ page: 'home' });
    expect(chatContext({ kind: 'search', query: 'x' })).toEqual({ page: 'search' });
    expect(chatContext({ kind: 'product', id: 'p1' })).toEqual({ page: 'product', viewing_product_id: 'p1' });
    expect(chatContext({ kind: 'account', tab: 'orders' })).toEqual({ page: 'account' });
    expect(chatContext({ kind: 'basket' })).toEqual({ page: 'basket' });
    expect(chatContext({ kind: 'lab' })).toEqual({ page: 'home' });
  });

  it('adds a guest summary only when there is one', () => {
    const summary = {
      categories: [],
      viewed: [],
      searches: ['boots'],
      basket: [],
      wishlist: [],
      filters: [],
      events: 1,
    };
    expect(chatContext({ kind: 'home' }, summary)).toEqual({ page: 'home', activity_summary: summary });
    expect(chatContext({ kind: 'home' }, undefined)).not.toHaveProperty('activity_summary');
  });
});

describe('money and the basket count', () => {
  it('shows pence as pounds', () => {
    expect(money(0)).toBe('£0.00');
    expect(money(1250)).toBe('£12.50');
    expect(money(123450)).toBe('£1,234.50');
    expect(money(undefined)).toBe('£0.00');
  });

  it('counts quantities', () => {
    expect(basketCount(basket)).toBe(2);
    expect(basketCount(null)).toBe(0);
  });
});
