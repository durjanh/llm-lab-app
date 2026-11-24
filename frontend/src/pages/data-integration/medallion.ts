/* The medallion demo's data and rules: invented support tickets land raw in bronze, and the rules the reader switches
   on decide what reaches silver, the gold tables, the feature table and the vector index. Pure functions, so the
   page and the tests see the same result. */

export interface RawTicket {
  /** The load the row arrived in: batch 2 repeats two rows and renames a column, as real sources do. */
  batch: 1 | 2;
  id: string;
  customer: string;
  created: string;
  product: string;
  body: string;
  priority?: string;
  prio?: string;
  channel?: string;
}

/** Twelve invented rows, with the faults the rules exist for: replays, mixed date formats, an impossible date, an
    empty body, contact details in the text, a renamed column and inconsistent product names. */
export const RAW: RawTicket[] = [
  {
    batch: 1,
    id: 'T-1001',
    customer: 'C-17',
    created: '2026-03-02',
    product: 'Boiler X2',
    body: 'Pressure drops every morning. Call me on 07700 900123.',
    priority: 'high',
  },
  {
    batch: 1,
    id: 'T-1002',
    customer: 'C-04',
    created: '02/03/2026',
    product: 'Thermostat T5',
    body: 'Display blank after the update.',
    priority: 'normal',
  },
  {
    batch: 1,
    id: 'T-1003',
    customer: 'C-17',
    created: '3 Mar 2026',
    product: 'Boiler X2',
    body: 'Same pressure fault as last week.',
    priority: 'high',
  },
  {
    batch: 1,
    id: 'T-1004',
    customer: 'C-22',
    created: '2026-03-31T09:12:00Z',
    product: 'Smart valve',
    body: 'Valve clicks but no flow. Email jo.bloggs@example.com.',
    priority: 'low',
  },
  {
    batch: 1,
    id: 'T-1005',
    customer: 'C-09',
    created: '2026-13-02',
    product: 'Thermostat T5',
    body: 'Schedule resets overnight.',
    priority: 'normal',
  },
  {
    batch: 1,
    id: 'T-1006',
    customer: 'C-31',
    created: '2026-03-05',
    product: 'Boiler X2',
    body: '',
    priority: 'normal',
  },
  {
    batch: 2,
    id: 'T-1003',
    customer: 'C-17',
    created: '3 Mar 2026',
    product: 'Boiler X2',
    body: 'Same pressure fault as last week.',
    prio: 'P1',
  },
  {
    batch: 2,
    id: 'T-1007',
    customer: 'C-04',
    created: '2026-04-01',
    product: 'Thermostat T5',
    body: 'Thermostat loses Wi-Fi.',
    prio: 'P1',
    channel: 'chat',
  },
  {
    batch: 2,
    id: 'T-1008',
    customer: 'C-22',
    created: '2026-04-02',
    product: 'smart valve ',
    body: 'Leak at the valve body.',
    prio: 'P3',
    channel: 'phone',
  },
  {
    batch: 2,
    id: 'T-1001',
    customer: 'C-17',
    created: '2026-03-02',
    product: 'Boiler X2',
    body: 'Pressure drops every morning. Call me on 07700 900123.',
    prio: 'P1',
  },
  {
    batch: 2,
    id: 'T-1009',
    customer: 'C-09',
    created: '2026-04-03',
    product: 'BOILER X2',
    body: 'Boiler shows fault E119 after a reset.',
    prio: 'P2',
    channel: 'chat',
  },
  {
    batch: 2,
    id: 'T-1010',
    customer: 'C-17',
    created: 'April 4th',
    product: 'Boiler X2',
    body: 'Pressure fault again.',
    prio: 'P1',
    channel: 'phone',
  },
];

export interface Rules {
  /** Parse the four date formats seen and quarantine dates that are not real. */
  dates: boolean;
  /** Keep one row per ticket id, so a replayed load is not counted twice. */
  dedupe: boolean;
  /** Quarantine tickets with no text. */
  requireBody: boolean;
  /** Map the renamed column and the product spellings onto one schema. */
  conform: boolean;
  /** Replace phone numbers and email addresses before text reaches the index. */
  maskPii: boolean;
}

export const ALL_RULES: Rules = { dates: true, dedupe: true, requireBody: true, conform: true, maskPii: true };
export const NO_RULES: Rules = { dates: false, dedupe: false, requireBody: false, conform: false, maskPii: false };

export interface SilverRow {
  id: string;
  customer: string;
  /** ISO date when parsed, otherwise the raw text. */
  date: string;
  month: string;
  product: string;
  priority: string | null;
  body: string;
}

export interface Quarantined {
  id: string;
  batch: number;
  reason: string;
}

export interface GoldRow {
  month: string;
  product: string;
  tickets: number;
  high: number;
}

export interface FeatureRow {
  customer: string;
  tickets: number;
  highShare: number;
}

export interface Chunk {
  id: string;
  text: string;
  pii: boolean;
}

export interface MedallionResult {
  bronze: number;
  silver: SilverRow[];
  quarantine: Quarantined[];
  gold: GoldRow[];
  features: FeatureRow[];
  chunks: Chunk[];
  /** What is wrong downstream because a rule is off. Empty when every rule is on. */
  issues: string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DATE_FORMATS = [
  /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+Z?)?$/,
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/,
];

/** True when the text has the shape of a format the pipeline reads, whether or not the date itself exists. */
export function isAcceptedDateFormat(text: string): boolean {
  return DATE_FORMATS.some((f) => f.test(text.trim()));
}

/** A real calendar date as YYYY-MM-DD, or null. Accepts ISO dates and timestamps, DD/MM/YYYY and "3 Mar 2026". */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  let match = t.match(/^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+Z?)?$/);
  if (match) [y, m, d] = [+match[1], +match[2], +match[3]];
  else if ((match = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [d, m, y] = [+match[1], +match[2], +match[3]];
  else if ((match = t.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/))) {
    const i = MONTHS.indexOf(match[2].toLowerCase());
    if (i < 0) return null;
    [d, m, y] = [+match[1], i + 1, +match[3]];
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const PRODUCTS: Record<string, string> = {
  'boiler x2': 'Boiler X2',
  'thermostat t5': 'Thermostat T5',
  'smart valve': 'Smart valve',
};
const PRIO: Record<string, string> = { P1: 'high', P2: 'normal', P3: 'low' };

// UK numbers written the usual ways: 07700 900123, 07700900123, +44 7700 900123, 020 7946 0018.
const PHONE_SOURCE = String.raw`(?:\+44 ?|\b0)\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}\b`;
const EMAIL_SOURCE = String.raw`[\w.+-]+@[\w-]+\.[\w.]+\w`;
const PHONE = new RegExp(PHONE_SOURCE, 'g');
const EMAIL = new RegExp(EMAIL_SOURCE, 'g');
/** True when the text still holds a phone number or an email address. */
export const hasPii = (s: string) => new RegExp(PHONE_SOURCE).test(s) || new RegExp(EMAIL_SOURCE).test(s);
/** Replaces phone numbers and email addresses with placeholders. */
export const maskPii = (s: string) => s.replace(PHONE, '[phone]').replace(EMAIL, '[email]');

/** Runs bronze → silver → gold, features and the index with the given rules, and lists what the missing rules cost. */
export function runMedallion(rules: Rules, raw: RawTicket[] = RAW): MedallionResult {
  const quarantine: Quarantined[] = [];
  const silver: SilverRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const r of raw) {
    if (rules.dedupe && seen.has(r.id)) continue;
    if (seen.has(r.id)) duplicates++;
    seen.add(r.id);
    if (rules.requireBody && !r.body.trim()) {
      quarantine.push({ id: r.id, batch: r.batch, reason: 'no ticket text' });
      continue;
    }
    let date = r.created;
    let month: string;
    if (rules.dates) {
      const parsed = parseDate(r.created);
      if (!parsed) {
        const reason = isAcceptedDateFormat(r.created)
          ? `date "${r.created}" is not a real date`
          : `date "${r.created}" is in a format the pipeline does not accept`;
        quarantine.push({ id: r.id, batch: r.batch, reason });
        continue;
      }
      date = parsed;
      month = parsed.slice(0, 7);
    } else {
      // Without parsing, the month is whatever the first seven characters happen to be.
      month = r.created.slice(0, 7);
    }
    const product = rules.conform ? (PRODUCTS[r.product.trim().toLowerCase()] ?? r.product.trim()) : r.product;
    const priority = rules.conform ? (r.priority ?? (r.prio ? PRIO[r.prio] : null) ?? null) : (r.priority ?? null);
    const body = rules.maskPii ? maskPii(r.body) : r.body;
    silver.push({ id: r.id, customer: r.customer, date, month, product, priority, body });
  }

  const goldMap = new Map<string, GoldRow>();
  for (const s of silver) {
    const key = `${s.month}|${s.product}`;
    const g = goldMap.get(key) ?? { month: s.month, product: s.product, tickets: 0, high: 0 };
    g.tickets++;
    if (s.priority === 'high') g.high++;
    goldMap.set(key, g);
  }
  const gold = [...goldMap.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.product.localeCompare(b.product),
  );

  const featMap = new Map<string, { tickets: number; high: number }>();
  for (const s of silver) {
    const f = featMap.get(s.customer) ?? { tickets: 0, high: 0 };
    f.tickets++;
    if (s.priority === 'high') f.high++;
    featMap.set(s.customer, f);
  }
  const features = [...featMap.entries()]
    .map(([customer, f]) => ({ customer, tickets: f.tickets, highShare: f.tickets ? f.high / f.tickets : 0 }))
    .sort((a, b) => a.customer.localeCompare(b.customer));

  const chunks = silver.map((s) => ({ id: s.id, text: s.body, pii: hasPii(s.body) }));

  const issues: string[] = [];
  if (duplicates) issues.push(`${duplicates} replayed tickets counted twice in gold, the features and the index.`);
  const badMonths = new Set(silver.filter((s) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.month)).map((s) => s.month));
  if (badMonths.size)
    issues.push(
      `Gold has months that do not exist or are not months: ${[...badMonths].map((m) => `"${m}"`).join(', ')}.`,
    );
  const empty = chunks.filter((c) => !c.text.trim()).length;
  if (empty) issues.push(`${empty} empty text embedded: a vector that matches nothing useful.`);
  const nullPrio = silver.filter((s) => s.priority === null).length;
  if (nullPrio)
    issues.push(`${nullPrio} rows lost their priority to the renamed column, so high-priority counts are low.`);
  const variants = new Set(silver.map((s) => s.product)).size;
  if (variants > 3) issues.push(`${variants} product names for three products, so gold splits one product's tickets.`);
  const pii = chunks.filter((c) => c.pii).length;
  if (pii) issues.push(`${pii} chunks in the vector index hold a phone number or email address.`);

  return { bronze: raw.length, silver, quarantine, gold, features, chunks, issues };
}
