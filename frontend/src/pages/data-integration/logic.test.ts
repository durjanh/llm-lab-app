import { describe, expect, it } from 'vitest';
import { ALL_RULES, NO_RULES, hasPii, maskPii, parseDate, runMedallion } from './medallion';
import { recommend } from './stores';
import { DEFAULT_GATEWAY, simulateGateway } from './gateway';
import { crash, finished, initStream, replayAll, report, restart, step, type StreamOptions } from './stream';

describe('medallion', () => {
  it('parses the formats seen and refuses impossible dates', () => {
    expect(parseDate('2026-03-02')).toBe('2026-03-02');
    expect(parseDate('02/03/2026')).toBe('2026-03-02');
    expect(parseDate('3 Mar 2026')).toBe('2026-03-03');
    expect(parseDate('2026-03-31T09:12:00Z')).toBe('2026-03-31');
    expect(parseDate('2026-13-02')).toBeNull();
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('April 4th')).toBeNull();
  });

  it('with every rule on, quarantines the bad rows and reports no issues', () => {
    const r = runMedallion(ALL_RULES);
    expect(r.bronze).toBe(12);
    expect(r.quarantine.map((q) => q.id).sort()).toEqual(['T-1005', 'T-1006', 'T-1010']);
    expect(r.silver).toHaveLength(7);
    expect(new Set(r.silver.map((s) => s.id)).size).toBe(7);
    expect(r.issues).toEqual([]);
    expect(r.chunks.some((c) => c.pii)).toBe(false);
    expect(new Set(r.gold.map((g) => g.product))).toEqual(new Set(['Boiler X2', 'Thermostat T5', 'Smart valve']));
  });

  it('with no rules, the faults reach gold and the index', () => {
    const r = runMedallion(NO_RULES);
    expect(r.silver).toHaveLength(12);
    expect(r.quarantine).toEqual([]);
    expect(r.issues.length).toBeGreaterThanOrEqual(5);
    expect(r.chunks.filter((c) => c.pii)).toHaveLength(3);
    expect(r.gold.some((g) => g.month === '2026-13')).toBe(true);
  });
});

describe('quarantine reasons and PII', () => {
  it('tells an impossible date from a format the pipeline does not read', () => {
    const reasons = Object.fromEntries(runMedallion(ALL_RULES).quarantine.map((q) => [q.id, q.reason]));
    expect(reasons['T-1005']).toContain('is not a real date');
    expect(reasons['T-1010']).toContain('format the pipeline does not accept');
  });

  it('masks UK phone numbers in the usual spellings', () => {
    for (const n of ['07700 900123', '07700900123', '+44 7700 900123', '020 7946 0018']) {
      expect(hasPii(`ring ${n} please`)).toBe(true);
      expect(maskPii(`ring ${n} please`)).toBe('ring [phone] please');
    }
  });

  it('leaves fault codes and dates alone', () => {
    for (const s of ['Boiler shows fault E119 after a reset.', 'Logged on 2026-03-04 at 09:15.']) {
      expect(hasPii(s)).toBe(false);
      expect(maskPii(s)).toBe(s);
    }
  });
});

describe('store chooser', () => {
  it('folds small-scale similarity into PostgreSQL with pgvector', () => {
    const a = recommend(['tx', 'similar'], 'small');
    expect(a.stores.map((s) => s.kind)).toEqual(['relational']);
    expect(a.combos.join(' ')).toMatch(/pgvector/);
  });

  it('keeps a dedicated vector index at large scale', () => {
    const a = recommend(['tx', 'similar'], 'large');
    expect(a.stores.map((s) => s.kind)).toEqual(['relational', 'vector']);
  });

  it('sends similarity plus full text to one search engine', () => {
    const a = recommend(['text', 'similar']);
    expect(a.stores.map((s) => s.kind)).toEqual(['search']);
    expect(a.combos.join(' ')).toMatch(/hybrid/);
  });

  it('gives nothing for no needs', () => {
    expect(recommend([])).toEqual({ stores: [], combos: [] });
  });
});

describe('gateway', () => {
  it('accounts for every token', () => {
    const r = simulateGateway({ ...DEFAULT_GATEWAY, outage: true, traffic: 2 });
    for (const t of r.consumers) {
      const sum = t.cache + t.limited + t.ptu + t.payg + t.backend429 + t.failed;
      expect(sum).toBeCloseTo(t.demand, 6);
    }
  });

  it('never sends more than the provisioned capacity to the provisioned backend', () => {
    const r = simulateGateway({ ...DEFAULT_GATEWAY, traffic: 3 });
    for (const m of r.minutes) expect(m.ptu).toBeLessThanOrEqual(DEFAULT_GATEWAY.ptuK + 1e-9);
  });

  it('without spillover, excess becomes backend 429s and nothing goes to pay-as-you-go', () => {
    const r = simulateGateway({ ...DEFAULT_GATEWAY, traffic: 2, spillover: false });
    expect(r.paygCost).toBe(0);
    expect(r.consumers.reduce((a, t) => a + t.backend429, 0)).toBeGreaterThan(0);
  });

  it('a circuit breaker loses far less in an outage than none', () => {
    const failed = (breaker: boolean) =>
      simulateGateway({ ...DEFAULT_GATEWAY, outage: true, breaker }).consumers.reduce((a, t) => a + t.failed, 0);
    expect(failed(true)).toBeGreaterThan(0);
    expect(failed(true)).toBeLessThan(failed(false) / 5);
  });

  it('the cache only helps the apps with repeated questions', () => {
    const r = simulateGateway(DEFAULT_GATEWAY);
    expect(r.consumers.find((c) => c.id === 'contracts')?.cache).toBe(0);
    expect(r.consumers.find((c) => c.id === 'help')?.cache).toBeGreaterThan(0);
  });
});

const run = (opts: StreamOptions, before?: (n: number, s: ReturnType<typeof initStream>) => typeof s) => {
  let s = initStream(opts);
  for (let i = 0; i < 40 && !finished(s); i++) {
    s = step(s, opts);
    if (before) s = before(i, s);
  }
  return s;
};

describe('stream', () => {
  const safe: StreamOptions = { keyed: true, idempotent: true, deadLetter: true, checkpointEvery: 3 };

  it('with every defence on, ends with one copy of the newest version of each document', () => {
    const s = run(safe);
    expect(finished(s)).toBe(true);
    expect(s.deadLetters.map((e) => e.id)).toEqual(['e7']);
    const r = report(s);
    expect(r).toEqual({ duplicateChunks: 0, stale: [], blocked: false });
    expect(s.index.A.version).toBe(3);
  });

  it('a crash before a checkpoint redelivers, and a plain consumer duplicates chunks', () => {
    const plain = { ...safe, idempotent: false };
    const s = run(plain, (i, st) => (i === 1 ? restart(crash(st)) : st));
    expect(report(s).duplicateChunks).toBeGreaterThan(0);
    const t = run(safe, (i, st) => (i === 1 ? restart(crash(st)) : st));
    expect(report(t).duplicateChunks).toBe(0);
  });

  it('without a partition key, an older version can overwrite a newer one', () => {
    const s = run({ ...safe, keyed: false });
    expect(report(s).stale).toContain('A');
  });

  it('without a dead-letter queue, the poison event blocks its partition', () => {
    const s = run({ ...safe, deadLetter: false });
    expect(finished(s)).toBe(false);
    expect(report(s).blocked).toBe(true);
  });

  it('a replay does not dead-letter the poison event a second time', () => {
    let r = replayAll(run(safe));
    for (let i = 0; i < 40 && !finished(r); i++) r = step(r, safe);
    expect(finished(r)).toBe(true);
    expect(r.deadLetters.map((e) => e.id)).toEqual(['e7']);
  });

  it('replaying from offset 0 with an idempotent consumer changes nothing', () => {
    const s = run(safe);
    let r = replayAll(s);
    for (let i = 0; i < 40 && !finished(r); i++) r = step(r, safe);
    expect(r.index).toEqual(s.index);
    expect(r.embedCalls).toBe(s.embedCalls);
  });
});
