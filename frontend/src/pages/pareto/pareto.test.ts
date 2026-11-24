import { describe, expect, it } from 'vitest';
import { SAMPLE } from './data';
import {
  bestWithin,
  dominates,
  frontier,
  frontier2d,
  logUnit,
  parseCsv,
  project,
  splitCsvLine,
  toCsv,
  type ModelPoint,
} from './pareto';

const m = (name: string, quality: number, cost: number, minutes: number, open = false): ModelPoint => ({
  name,
  provider: 'P',
  open,
  quality,
  cost,
  minutes,
});

describe('dominance', () => {
  it('needs no worse on all three and better on one', () => {
    expect(dominates(m('a', 50, 1, 1), m('b', 40, 1, 1))).toBe(true);
    expect(dominates(m('a', 50, 1, 1), m('b', 50, 1, 1))).toBe(false);
    expect(dominates(m('a', 50, 2, 1), m('b', 40, 1, 1))).toBe(false);
  });
});

describe('frontier', () => {
  const pts = [
    m('top', 60, 10, 10),
    m('slow', 35, 0.5, 5),
    m('cheap', 20, 0.01, 1),
    m('fast', 30, 1, 0.5),
    m('dud', 25, 2, 2),
  ];

  it('keeps every point nothing beats on all three, best quality first', () => {
    expect(frontier(pts).map((p) => p.name)).toEqual(['top', 'slow', 'fast', 'cheap']);
  });

  it('keeps both of two identical points, since neither is strictly better', () => {
    expect(frontier([m('a', 1, 1, 1), m('b', 1, 1, 1)])).toHaveLength(2);
  });

  it('on two measures can drop a point the three-measure frontier keeps', () => {
    const flat = frontier2d(pts, 'cost').map((p) => p.name);
    expect(flat).not.toContain('fast');
    expect(frontier(pts).map((p) => p.name)).toContain('fast');
  });

  it('on the sample, every frontier point is undominated and every other point is dominated', () => {
    const f = new Set(frontier(SAMPLE));
    for (const p of SAMPLE) expect(f.has(p)).toBe(!SAMPLE.some((q) => dominates(q, p)));
    expect(f.size).toBeGreaterThan(3);
    expect(f.size).toBeLessThan(SAMPLE.length);
  });
});

describe('best within limits', () => {
  const pts = [m('big', 60, 5, 5), m('mid', 45, 0.5, 2), m('open', 40, 0.2, 3, true)];
  it('picks the best quality that fits, and respects the open-weight filter', () => {
    expect(bestWithin(pts, { maxCost: 10, maxMinutes: 10, openOnly: false })?.name).toBe('big');
    expect(bestWithin(pts, { maxCost: 1, maxMinutes: 10, openOnly: false })?.name).toBe('mid');
    expect(bestWithin(pts, { maxCost: 1, maxMinutes: 10, openOnly: true })?.name).toBe('open');
    expect(bestWithin(pts, { maxCost: 0.1, maxMinutes: 10, openOnly: false })).toBeNull();
  });
});

describe('CSV', () => {
  it('splits quoted fields with commas and doubled quotes', () => {
    expect(splitCsvLine('"Model, large","say ""hi""",3')).toEqual(['Model, large', 'say "hi"', '3']);
  });

  it('reads good rows and reports each bad one by row number', () => {
    const r = parseCsv(
      'name,provider,open,quality,cost,minutes\nA,X,yes,50,1,2\n,X,no,1,1,1\nB,X,no,abc,1,1\nC,X,no,10,0,1\nD,,,20,0.5,1',
    );
    expect(r.models.map((p) => p.name)).toEqual(['A', 'D']);
    expect(r.models[0].open).toBe(true);
    expect(r.models[1].provider).toBe('Unknown');
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/^Row 3/);
  });

  it('refuses a header without the needed columns, and empty text', () => {
    expect(parseCsv('name,score\nA,1').errors[0]).toMatch(/quality, cost, minutes/);
    expect(parseCsv('  \n').errors).toHaveLength(1);
  });

  it('round-trips the sample', () => {
    expect(parseCsv(toCsv(SAMPLE))).toEqual({ models: SAMPLE, errors: [] });
  });
});

describe('scales and projection', () => {
  it('maps the ends of a log range to -1 and 1, and a flat range to 0', () => {
    expect(logUnit(0.01, 0.01, 100)).toBeCloseTo(-1);
    expect(logUnit(100, 0.01, 100)).toBeCloseTo(1);
    expect(logUnit(1, 0.01, 100)).toBeCloseTo(0);
    expect(logUnit(5, 5, 5)).toBe(0);
  });

  it('looking straight on, shows cheapness across and quality up', () => {
    const p = project(0.5, 0.3, 0.8, { yaw: 0, pitch: 0 });
    expect(p.sx).toBeCloseTo(0.5);
    expect(p.sy).toBeCloseTo(0.8);
  });
});

describe('pasted data edge cases', () => {
  it('reads a CSV that starts with a byte-order mark', () => {
    expect(parseCsv('﻿name,quality,cost,minutes\nA,50,1,2').models.map((p) => p.name)).toEqual(['A']);
  });

  it('never gives an empty quality axis, even when every score is the same', async () => {
    const { qualityRange } = await import('./pareto');
    for (const qs of [[-10, -10], [0, 0], [20], [-3, 47]]) {
      const [lo, hi] = qualityRange(qs);
      expect(hi).toBeGreaterThan(lo);
      expect(lo).toBeLessThanOrEqual(Math.min(...qs));
      expect(hi).toBeGreaterThanOrEqual(Math.max(...qs));
    }
  });
});
