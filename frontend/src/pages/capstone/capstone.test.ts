import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../tuning/gp';
import {
  BLACK_BOXES,
  EMPTY,
  bestByRound,
  clean,
  finished,
  history,
  measure,
  optimum,
  parseSaved,
  regretByRound,
  startingPoints,
  submitRound,
  toMarkdown,
} from './functions';
import { QUIZ } from './quiz';

const centre = (d: number) => Array.from({ length: d }, () => 0.5);

describe('the black boxes', () => {
  it('cover two to six inputs, and every bump has one centre value per input', () => {
    expect(BLACK_BOXES.map((b) => b.inputs.length)).toEqual([2, 3, 4, 5, 6]);
    for (const b of BLACK_BOXES) for (const bump of b.bumps) expect(bump.c).toHaveLength(b.inputs.length);
  });

  it('each optimum is the global maximum: no random point beats it', () => {
    for (const b of BLACK_BOXES) {
      const opt = optimum(b);
      expect(opt.value).toBeGreaterThan(0.99);
      const rand = mulberry32(5);
      for (let i = 0; i < 4000; i++) {
        const x = b.inputs.map(() => rand());
        expect(clean(b, x)).toBeLessThanOrEqual(opt.value + 1e-9);
      }
    }
  });

  it('measurements are repeatable and noisy only as much as stated', () => {
    for (const b of BLACK_BOXES) {
      const x = centre(b.inputs.length);
      expect(measure(b, x, 3)).toBe(measure(b, x, 3));
      expect(Math.abs(measure(b, x, 3) - clean(b, x))).toBeLessThan(5 * b.noiseSd + 1e-12);
    }
  });

  it('starting points are fixed and inside the unit cube', () => {
    for (const b of BLACK_BOXES) {
      const s = startingPoints(b);
      expect(s).toHaveLength(b.initial);
      expect(s).toEqual(startingPoints(b));
      for (const x of s) for (const v of x) expect(v >= 0 && v <= 1).toBe(true);
    }
  });

  it('pins the values the Python port must reproduce', () => {
    const oven = BLACK_BOXES[0];
    expect(clean(oven, [0.62, 0.35])).toBeCloseTo(1.0, 6);
    expect(startingPoints(oven)[0]).toEqual(startingPoints(oven)[0].map((v) => Math.round(v * 1000) / 1000));
    expect(mulberry32(1)()).toBeCloseTo(0.6270739405881613, 12);
  });
});

describe('rounds', () => {
  const oven = BLACK_BOXES[0];

  it('a round adds its points with measured outputs and the note', () => {
    const p = submitRound(
      oven,
      EMPTY,
      [
        [0.6, 0.3],
        [0.7, 0.4],
      ],
      'Tried around the best start.',
    );
    expect(p.queries).toHaveLength(2);
    expect(p.ys[0]).toBe(measure(oven, [0.6, 0.3], oven.initial));
    expect(p.notes).toEqual(['Tried around the best start.']);
    expect(history(oven, p)).toHaveLength(oven.initial + 2);
  });

  it('refuses the wrong count, values outside [0, 1], and rounds past the budget', () => {
    expect(() => submitRound(oven, EMPTY, [[0.5, 0.5]], '')).toThrow();
    expect(() =>
      submitRound(
        oven,
        EMPTY,
        [
          [0.5, 1.2],
          [0.1, 0.1],
        ],
        '',
      ),
    ).toThrow();
    expect(() =>
      submitRound(
        oven,
        EMPTY,
        [
          [0.5, Number.NaN],
          [0.1, 0.1],
        ],
        '',
      ),
    ).toThrow();
    let p = EMPTY;
    for (let r = 0; r < oven.rounds; r++)
      p = submitRound(
        oven,
        p,
        [
          [r / 20, 0.5],
          [0.5, r / 20],
        ],
        '',
      );
    expect(finished(oven, p)).toBe(true);
    expect(() =>
      submitRound(
        oven,
        p,
        [
          [0.1, 0.1],
          [0.2, 0.2],
        ],
        '',
      ),
    ).toThrow();
  });

  it('best so far never falls and regret never rises', () => {
    let p = EMPTY;
    const rand = mulberry32(9);
    for (let r = 0; r < 5; r++)
      p = submitRound(
        oven,
        p,
        [
          [rand(), rand()],
          [rand(), rand()],
        ],
        '',
      );
    const best = bestByRound(oven, p);
    const regret = regretByRound(oven, p);
    expect(best).toHaveLength(6);
    for (let i = 1; i < best.length; i++) expect(best[i]).toBeGreaterThanOrEqual(best[i - 1]);
    for (const r of regret) expect(r).toBeGreaterThanOrEqual(0);
  });

  it('exports Markdown with the rounds, and reveals the optimum only when finished', () => {
    let p = submitRound(
      oven,
      EMPTY,
      [
        [0.6, 0.3],
        [0.7, 0.4],
      ],
      'First guess.',
    );
    expect(toMarkdown(oven, p)).toContain('### Round 1');
    expect(toMarkdown(oven, p)).not.toContain('Known optimum');
    for (let r = 1; r < oven.rounds; r++)
      p = submitRound(
        oven,
        p,
        [
          [0.62, 0.35],
          [0.5, 0.5],
        ],
        '',
      );
    expect(toMarkdown(oven, p)).toContain('Known optimum');
  });
});

describe('saved progress', () => {
  const oven = BLACK_BOXES[0];

  it('round-trips and recomputes outputs from the queries', () => {
    const p = submitRound(
      oven,
      EMPTY,
      [
        [0.6, 0.3],
        [0.7, 0.4],
      ],
      'note',
    );
    const tampered = JSON.stringify({ oven: { ...p, ys: [99, 99] } });
    const back = parseSaved(tampered).oven;
    expect(back.ys).toEqual(p.ys);
  });

  it('drops malformed or impossible saves', () => {
    expect(parseSaved('not json')).toEqual({});
    expect(parseSaved(JSON.stringify({ oven: { queries: [[0.1]], ys: [1], notes: [] } }))).toEqual({});
    expect(parseSaved(null)).toEqual({});
  });
});

describe('quiz', () => {
  it('has four questions for week 25, each with a valid answer', () => {
    expect(QUIZ.filter((q) => q.week === 25)).toHaveLength(4);
    for (const q of QUIZ) expect(q.answer).toBeLessThan(q.options.length);
  });
});

describe('the optimum with overlapping bumps', () => {
  it('is the best bump centre by clean value, not just the tallest bump', async () => {
    const { BLACK_BOXES, clean, optimum } = await import('./functions');
    const box = {
      ...BLACK_BOXES[0],
      bumps: [
        { h: 1, c: [0.9, 0.9], w: 0.05 },
        { h: 0.8, c: [0.2, 0.2], w: 0.3 },
        { h: 0.8, c: [0.25, 0.2], w: 0.3 },
      ],
    };
    const best = optimum(box);
    expect(best.value).toBeGreaterThan(clean(box, [0.9, 0.9]));
    expect(best.value).toBeCloseTo(Math.max(...box.bumps.map((b) => clean(box, b.c))));
  });
});
