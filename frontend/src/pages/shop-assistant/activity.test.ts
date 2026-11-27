import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_KEY,
  ActivityTracker,
  CONSENT_KEY,
  MAX_AGE_MS,
  MAX_LOCAL,
  readLocal,
  signInWithHistory,
  summarise,
  type ActivityEvent,
  type StorageLike,
} from './activity';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

/** Storage that throws on every call, as a browser with site data blocked does. */
const blocked: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const make = (storage: StorageLike | null, send = vi.fn(async () => ({})), now = () => 1_000_000) => {
  const scheduled: (() => void)[] = [];
  const tracker = new ActivityTracker({
    storage,
    send,
    now,
    schedule: (fn) => scheduled.push(fn),
  });
  return { tracker, send, scheduled };
};

describe('consent', () => {
  it('records and sends nothing until the shopper allows personalisation', async () => {
    const storage = new MemoryStorage();
    const { tracker, send } = make(storage);
    expect(tracker.consent).toBeNull();
    expect(tracker.record('view_category', { category: 'Home' }, 'home')).toBeNull();
    tracker.setConsent('essential');
    expect(tracker.record('search', { query: 'lamp' }, 'home')).toBeNull();
    expect(storage.getItem(ACTIVITY_KEY)).toBeNull();
    expect(tracker.summary()).toBeUndefined();
    tracker.setSignedIn(true);
    tracker.record('add_to_wishlist', { product_id: 'p1' }, 'product');
    await tracker.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('remembers the choice, and essential only wipes what was kept', () => {
    const storage = new MemoryStorage();
    const { tracker } = make(storage);
    tracker.setConsent('personalise');
    tracker.record('view_category', { category: 'Home' }, 'home');
    expect(storage.getItem(ACTIVITY_KEY)).not.toBeNull();
    expect(make(storage).tracker.consent).toBe('personalise');
    tracker.setConsent('essential');
    expect(storage.getItem(ACTIVITY_KEY)).toBeNull();
    expect(storage.getItem(CONSENT_KEY)).toBe('essential');
  });
});

describe('the guest log', () => {
  it('keeps only allowed events with clipped props', () => {
    const storage = new MemoryStorage();
    const { tracker } = make(storage);
    tracker.setConsent('personalise');
    const e = tracker.record(
      'search',
      { query: 'x'.repeat(500), filters: { colour: 'navy', evil: { nested: 1 } } },
      'home',
    );
    expect(e?.props.query).toHaveLength(200);
    expect(e?.props.filters).toEqual({ colour: 'navy' });
    expect(tracker.record('view_product', { product_id: 'p1', seconds: 99999 }, 'product')?.props.seconds).toBe(3600);
    expect(tracker.record('order_placed' as never, { order_id: 'o1' }, 'basket')).toBeNull();
    expect(tracker.guestEvents()).toHaveLength(2);
  });

  it('keeps the newest 500 and drops anything older than 30 days', () => {
    const storage = new MemoryStorage();
    let t = 1_000_000;
    const { tracker } = make(storage, undefined, () => t);
    tracker.setConsent('personalise');
    for (let i = 0; i < MAX_LOCAL + 20; i++) tracker.record('view_category', { category: `c${i}` }, 'home');
    const kept = tracker.guestEvents();
    expect(kept).toHaveLength(MAX_LOCAL);
    expect(kept.at(-1)?.props.category).toBe(`c${MAX_LOCAL + 19}`);
    t += MAX_AGE_MS + 1;
    expect(tracker.guestEvents()).toHaveLength(0);
  });

  it('shrugs off a corrupt log', () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVITY_KEY, '{not json');
    expect(readLocal(storage)).toEqual([]);
    storage.setItem(ACTIVITY_KEY, JSON.stringify([{ type: 'view_category' }, 7]));
    expect(readLocal(storage)).toEqual([]);
  });

  it('keeps nothing, and does not throw, when storage is blocked', () => {
    for (const storage of [blocked, null]) {
      const { tracker } = make(storage);
      tracker.setConsent('personalise');
      expect(tracker.consent).toBe('personalise'); // holds for this page view
      expect(() => tracker.record('view_category', { category: 'Home' }, 'home')).not.toThrow();
      expect(tracker.guestEvents()).toEqual([]);
      expect(tracker.summary()).toBeUndefined();
      expect(() => tracker.clearLocal()).not.toThrow();
    }
  });
});

describe('the summary the chat sends', () => {
  it('is compact and capped, and never carries the raw log', () => {
    const events: ActivityEvent[] = [];
    let n = 0;
    const add = (type: ActivityEvent['type'], props: ActivityEvent['props']) =>
      events.push({ event_id: `e${n}`, type, ts: n++, page: 'home', props });
    for (let i = 0; i < 400; i++) {
      add('view_category', { category: `Cat${i % 9}` });
      add('view_product', { product_id: `p${i}`, seconds: 30 });
      add('search', { query: `query number ${i} ${'y'.repeat(150)}`, filters: {} });
      add('add_to_basket', { product_id: `b${i}`, qty: 1 });
      add('add_to_wishlist', { product_id: `w${i}` });
      add('filter', { name: `f${i}`, value: 'v' });
    }
    const s = summarise(events);
    expect(s.categories.length).toBeLessThanOrEqual(5);
    expect(s.viewed.length).toBeLessThanOrEqual(10);
    expect(s.searches.length).toBeLessThanOrEqual(5);
    expect(s.searches.every((q) => q.length <= 80)).toBe(true);
    expect(s.basket.length).toBeLessThanOrEqual(10);
    expect(s.wishlist.length).toBeLessThanOrEqual(10);
    expect(s.filters.length).toBeLessThanOrEqual(6);
    expect(s.events).toBe(events.length);
    expect(JSON.stringify(s).length).toBeLessThan(2500);
    expect(JSON.stringify(s)).not.toContain('event_id');
    // The newest come first.
    expect(s.viewed[0].product_id).toBe('p399');
  });

  it('adds up seconds per product and drops items taken out of the basket', () => {
    const e = (type: ActivityEvent['type'], props: ActivityEvent['props'], ts: number): ActivityEvent => ({
      event_id: String(ts),
      type,
      ts,
      page: 'home',
      props,
    });
    const s = summarise([
      e('view_product', { product_id: 'p1', seconds: 20 }, 1),
      e('view_product', { product_id: 'p1', seconds: 15 }, 2),
      e('add_to_basket', { product_id: 'p1', qty: 1 }, 3),
      e('remove_from_basket', { product_id: 'p1' }, 4),
    ]);
    expect(s.viewed).toEqual([{ product_id: 'p1', seconds: 35 }]);
    expect(s.basket).toEqual([]);
  });

  it('is not sent for a signed-in shopper, whose profile is on the server', () => {
    const { tracker } = make(new MemoryStorage());
    tracker.setConsent('personalise');
    tracker.record('view_category', { category: 'Home' }, 'home');
    expect(tracker.summary()).toBeDefined();
    tracker.setSignedIn(true);
    expect(tracker.summary()).toBeUndefined();
  });
});

describe('signed-in batches', () => {
  it('waits, then sends a burst of events in one request', async () => {
    const { tracker, send, scheduled } = make(new MemoryStorage());
    tracker.setConsent('personalise');
    tracker.setSignedIn(true);
    tracker.record('view_category', { category: 'Home' }, 'home');
    tracker.record('search', { query: 'lamp' }, 'home');
    expect(send).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1); // one timer for the burst
    scheduled[0]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0] as unknown as [ActivityEvent[]])[0]).toHaveLength(2);
    expect(tracker.pending).toBe(0);
  });

  it('sends at most 100 at a time', async () => {
    const { tracker, send } = make(new MemoryStorage());
    tracker.setConsent('personalise');
    tracker.setSignedIn(true);
    for (let i = 0; i < 250; i++) tracker.record('view_category', { category: 'Home' }, 'home');
    await tracker.flush();
    const sizes = send.mock.calls.map((c) => (c as unknown as [ActivityEvent[]])[0].length);
    expect(sizes.every((n) => n <= 100)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it('keeps a failed batch for the next try, and does not send twice at once', async () => {
    let fail = true;
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      if (fail) throw new Error('offline');
      return {};
    });
    const { tracker, scheduled } = make(new MemoryStorage(), send);
    tracker.setConsent('personalise');
    tracker.setSignedIn(true);
    tracker.record('view_category', { category: 'Home' }, 'home');
    await Promise.all([tracker.flush(), tracker.flush()]);
    expect(calls).toBe(1);
    expect(tracker.pending).toBe(1);
    expect(scheduled.length).toBeGreaterThan(0);
    fail = false;
    await tracker.flush();
    expect(tracker.pending).toBe(0);
  });

  it('works with storage blocked', async () => {
    const { tracker, send } = make(blocked);
    tracker.setConsent('personalise');
    tracker.setSignedIn(true);
    tracker.record('view_category', { category: 'Home' }, 'home');
    await tracker.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('drops the queue on sign-out', () => {
    const { tracker } = make(new MemoryStorage());
    tracker.setConsent('personalise');
    tracker.setSignedIn(true);
    tracker.record('view_category', { category: 'Home' }, 'home');
    tracker.setSignedIn(false);
    expect(tracker.pending).toBe(0);
  });
});

describe('moving guest history into an account', () => {
  const guest = () => {
    const storage = new MemoryStorage();
    const { tracker } = make(storage);
    tracker.setConsent('personalise');
    tracker.record('view_category', { category: 'Outdoor' }, 'home');
    tracker.record('search', { query: 'tent' }, 'home');
    return { storage, tracker };
  };

  it('sends the guest events and clears the local copy when the server took them', async () => {
    const { storage, tracker } = guest();
    const call = vi.fn(async (events: ActivityEvent[]) => ({ token: 't', got: events.length }));
    const r = await signInWithHistory(tracker, call);
    expect(r.got).toBe(2);
    expect(storage.getItem(ACTIVITY_KEY)).toBeNull();
    expect(tracker.summary()).toBeUndefined();
  });

  it('keeps the local copy when sign-in fails, so a retry sends the same events', async () => {
    const { storage, tracker } = guest();
    const first = vi.fn(async (_events: ActivityEvent[]) => {
      throw new Error('server down');
    });
    await expect(signInWithHistory(tracker, first)).rejects.toThrow('server down');
    expect(storage.getItem(ACTIVITY_KEY)).not.toBeNull();
    const sent = first.mock.calls[0][0].map((e) => e.event_id);
    const second = vi.fn(async (events: ActivityEvent[]) => events.map((e) => e.event_id));
    expect(await signInWithHistory(tracker, second)).toEqual(sent);
  });

  it('sends nothing for a guest who did not consent', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      ACTIVITY_KEY,
      JSON.stringify([{ event_id: 'old', type: 'view_category', ts: 1_000_000, page: 'home', props: {} }]),
    );
    const { tracker } = make(storage);
    tracker.setConsent('essential');
    const call = vi.fn(async (events: ActivityEvent[]) => events.length);
    expect(await signInWithHistory(tracker, call)).toBe(0);
  });
});
