/* What a shopper browses, recorded only with their consent. A guest's events stay in this browser (localStorage,
   the newest 500, for 30 days) and the chat is sent a short summary built from them, never the log itself. A
   signed-in shopper's events go to the server in batches. On sign-in or account creation the guest's events are
   handed to the server once and the local copy is cleared only when that worked. Storage can be blocked (a private
   window, site data switched off): then nothing is kept and the shop still works. */

export const ACTIVITY_KEY = 'larkfield.activity.v1';
export const CONSENT_KEY = 'larkfield.consent.v1';
export const MAX_LOCAL = 500;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const BATCH = 100;
const QUERY_MAX = 200;

/** The only events the page records; the server checks the same list. `order_placed` is made by the server. */
export const EVENT_TYPES = [
  'view_product',
  'search',
  'view_category',
  'filter',
  'add_to_basket',
  'remove_from_basket',
  'add_to_wishlist',
  'checkout_started',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface ActivityEvent {
  event_id: string;
  type: EventType;
  /** When it happened, in milliseconds since 1970. */
  ts: number;
  page: string;
  props: Record<string, string | number | boolean | Record<string, string | number | boolean>>;
}

/** The short account of a guest's browsing that the chat sends as `context.activity_summary`. */
export interface ActivitySummary {
  categories: { category: string; count: number }[];
  viewed: { product_id: string; seconds: number }[];
  searches: string[];
  basket: string[];
  wishlist: string[];
  filters: { name: string; value: string }[];
  events: number;
}

export type Consent = 'personalise' | 'essential' | null;

/** The part of localStorage the tracker uses, so tests can pass a fake or one that throws. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's localStorage, or null where reading it throws. */
export function browserStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    s.getItem(CONSENT_KEY);
    return s;
  } catch {
    return null;
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Older browsers: a version 4 UUID from Math.random; it only has to be unique to this shopper.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n);
const num = (v: unknown, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo;
};

/** Keeps only the props each event type allows, clipped to sane sizes; null for an unknown type. */
export function cleanProps(type: string, props: Record<string, unknown>): ActivityEvent['props'] | null {
  switch (type) {
    case 'view_product':
      return { product_id: clip(props.product_id, 64), seconds: num(props.seconds, 0, 3600) };
    case 'search': {
      const filters: Record<string, string | number | boolean> = {};
      const raw = (props.filters ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw).slice(0, 8)) {
        if (typeof v === 'number' || typeof v === 'boolean') filters[clip(k, 32)] = v;
        else if (typeof v === 'string') filters[clip(k, 32)] = clip(v, 40);
      }
      return { query: clip(props.query, QUERY_MAX), filters };
    }
    case 'view_category':
      return { category: clip(props.category, 40) };
    case 'filter':
      return { name: clip(props.name, 32), value: clip(props.value, 40) };
    case 'add_to_basket':
      return { product_id: clip(props.product_id, 64), qty: num(props.qty, 1, 99) };
    case 'remove_from_basket':
    case 'add_to_wishlist':
      return { product_id: clip(props.product_id, 64) };
    case 'checkout_started':
      return {};
    default:
      return null;
  }
}

/** Reads the guest log, dropping anything malformed or older than 30 days. */
export function readLocal(storage: StorageLike | null, now = Date.now()): ActivityEvent[] {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(ACTIVITY_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is ActivityEvent =>
          !!e &&
          typeof e.event_id === 'string' &&
          (EVENT_TYPES as readonly string[]).includes(e.type) &&
          typeof e.ts === 'number' &&
          now - e.ts < MAX_AGE_MS,
      )
      .slice(-MAX_LOCAL);
  } catch {
    return [];
  }
}

function writeLocal(storage: StorageLike | null, events: ActivityEvent[]) {
  if (!storage) return;
  try {
    storage.setItem(ACTIVITY_KEY, JSON.stringify(events.slice(-MAX_LOCAL)));
  } catch {
    /* full or blocked: keep nothing rather than fail the shop */
  }
}

/** The compact summary of a guest's events: a few counts and ids, capped, and no event in full. */
export function summarise(events: ActivityEvent[]): ActivitySummary {
  const cats = new Map<string, number>();
  const seconds = new Map<string, number>();
  const searches: string[] = [];
  const basket = new Set<string>();
  const removed = new Set<string>(); // taken out later than any add seen so far (we read newest first)
  const wish = new Set<string>();
  const filters = new Map<string, string>();
  // Newest first, so the caps keep the most recent.
  for (const e of [...events].reverse()) {
    const p = e.props as Record<string, unknown>;
    switch (e.type) {
      case 'view_category':
        cats.set(String(p.category), (cats.get(String(p.category)) ?? 0) + 1);
        break;
      case 'view_product': {
        const id = String(p.product_id);
        if (seconds.has(id) || seconds.size < 10)
          seconds.set(id, Math.min(3600, (seconds.get(id) ?? 0) + Number(p.seconds || 0)));
        break;
      }
      case 'search': {
        const q = String(p.query ?? '')
          .trim()
          .slice(0, 80);
        if (q && searches.length < 5 && !searches.includes(q)) searches.push(q);
        break;
      }
      case 'add_to_basket':
        if (basket.size < 10 && !removed.has(String(p.product_id))) basket.add(String(p.product_id));
        break;
      case 'remove_from_basket':
        if (!basket.has(String(p.product_id))) removed.add(String(p.product_id));
        break;
      case 'add_to_wishlist':
        if (wish.size < 10) wish.add(String(p.product_id));
        break;
      case 'filter':
        if (filters.size < 6 && !filters.has(String(p.name))) filters.set(String(p.name), String(p.value).slice(0, 40));
        break;
    }
  }
  return {
    categories: [...cats.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([category, count]) => ({ category, count })),
    viewed: [...seconds.entries()].map(([product_id, s]) => ({ product_id, seconds: s })),
    searches,
    basket: [...basket],
    wishlist: [...wish],
    filters: [...filters.entries()].map(([name, value]) => ({ name, value })),
    events: events.length,
  };
}

/** True when a summary has nothing in it worth sending. */
export const isEmptySummary = (s: ActivitySummary) =>
  !s.categories.length && !s.viewed.length && !s.searches.length && !s.basket.length && !s.wishlist.length;

export interface TrackerOptions {
  storage: StorageLike | null;
  /** Sends a signed-in shopper's batch; rejects if it did not arrive. */
  send: (events: ActivityEvent[]) => Promise<unknown>;
  now?: () => number;
  /** Waits before sending a batch, so a burst of clicks goes in one request. */
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
}

/** Records the shop's events for the current shopper: locally for a consenting guest, in batches when signed in. */
export class ActivityTracker {
  private consentValue: Consent;
  private signedIn = false;
  private queue: ActivityEvent[] = [];
  private sending: Promise<void> | null = null;
  private timer: unknown = null;
  private readonly now: () => number;

  constructor(private readonly opts: TrackerOptions) {
    this.now = opts.now ?? Date.now;
    let c: Consent = null;
    try {
      const v = opts.storage?.getItem(CONSENT_KEY);
      if (v === 'personalise' || v === 'essential') c = v;
    } catch {
      /* blocked: ask again */
    }
    this.consentValue = c;
  }

  get consent(): Consent {
    return this.consentValue;
  }

  /** Records the shopper's choice. Choosing essential only also wipes what this browser had kept. */
  setConsent(c: 'personalise' | 'essential') {
    this.consentValue = c;
    try {
      this.opts.storage?.setItem(CONSENT_KEY, c);
    } catch {
      /* the choice holds for this page view */
    }
    if (c === 'essential') {
      this.clearLocal();
      this.queue = [];
    }
  }

  /** Switches between guest (local) and signed-in (server) recording. */
  setSignedIn(on: boolean) {
    this.signedIn = on;
    if (!on) this.queue = [];
  }

  /** Records one event if the shopper allowed it; returns it, or null when nothing was kept. */
  record(type: EventType, props: Record<string, unknown>, page: string): ActivityEvent | null {
    if (this.consentValue !== 'personalise') return null;
    const clean = cleanProps(type, props);
    if (!clean) return null;
    const e: ActivityEvent = { event_id: newId(), type, ts: this.now(), page: clip(page, 20), props: clean };
    if (this.signedIn) {
      this.queue.push(e);
      if (this.queue.length > MAX_LOCAL) this.queue = this.queue.slice(-MAX_LOCAL);
      if (this.queue.length >= BATCH) void this.flush();
      else this.later();
    } else {
      if (!this.opts.storage) return null;
      writeLocal(this.opts.storage, [...readLocal(this.opts.storage, this.now()), e]);
    }
    return e;
  }

  private later() {
    if (this.timer !== null) return;
    const schedule = this.opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = schedule(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.delayMs ?? 4000);
  }

  /** Sends what is waiting, at most 100 at a time; a failed batch goes back on the queue for the next try. */
  flush(): Promise<void> {
    // A flush already under way picks up what was queued since, so a second caller waits for that one.
    if (this.sending) return this.sending;
    if (!this.signedIn || !this.queue.length) return Promise.resolve();
    this.sending = this.drain().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async drain(): Promise<void> {
    while (this.queue.length && this.signedIn) {
      const batch = this.queue.slice(0, BATCH);
      try {
        await this.opts.send(batch);
      } catch {
        this.later();
        return;
      }
      // Remove exactly what was sent: events recorded meanwhile stay queued.
      const sent = new Set(batch.map((e) => e.event_id));
      this.queue = this.queue.filter((e) => !sent.has(e.event_id));
    }
  }

  /** Events waiting to be sent (for tests and the activity panel). */
  get pending(): number {
    return this.queue.length;
  }

  /** The guest's events kept in this browser, for the merge on sign-in. */
  guestEvents(): ActivityEvent[] {
    return readLocal(this.opts.storage, this.now());
  }

  /** The summary the guest's chat sends, or undefined without consent or with nothing to say. */
  summary(): ActivitySummary | undefined {
    if (this.consentValue !== 'personalise' || this.signedIn) return undefined;
    const s = summarise(this.guestEvents());
    return isEmptySummary(s) ? undefined : s;
  }

  clearLocal() {
    try {
      this.opts.storage?.removeItem(ACTIVITY_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}

/**
 * Signs in (or creates an account) carrying the guest's events, and clears the local copy only once the server has
 * them. A failure leaves the guest's history where it was, so a retry sends the same events (the server ignores
 * event ids it already has).
 */
export async function signInWithHistory<T>(
  tracker: ActivityTracker,
  call: (guestEvents: ActivityEvent[]) => Promise<T>,
): Promise<T> {
  const events = tracker.consent === 'personalise' ? tracker.guestEvents() : [];
  const result = await call(events);
  tracker.clearLocal();
  tracker.setSignedIn(true);
  return result;
}
