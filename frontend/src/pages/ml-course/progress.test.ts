import { describe, expect, it } from 'vitest';
import { EMPTY, load, passed, recordScore, save, toggleDone } from './progress';
import { WEEKS, PARTS } from './weeks';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('progress', () => {
  it('round-trips through storage', () => {
    const s = memory();
    const p = recordScore(toggleDone(EMPTY, 3), 3, 4);
    save(p, s);
    expect(load(s)).toEqual(p);
  });

  it('survives missing, blocked and damaged storage', () => {
    expect(load(null)).toEqual(EMPTY);
    expect(load({ getItem: () => '{not json' })).toEqual(EMPTY);
    expect(
      load({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toEqual(EMPTY);
    expect(() =>
      save(EMPTY, {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });

  it('drops weeks outside the course and scores that are not numbers', () => {
    const s = { getItem: () => JSON.stringify({ done: [2, 2, 99, -1, 'x'], best: { 2: 3, 5: 'four' } }) };
    expect(load(s)).toEqual({ done: [2], best: { 2: 3 } });
  });

  it('never lowers a best score, and toggles a week both ways', () => {
    const p = recordScore(recordScore(EMPTY, 7, 4), 7, 1);
    expect(p.best[7]).toBe(4);
    expect(toggleDone(toggleDone(EMPTY, 7), 7).done).toEqual([]);
  });

  it('passes a quiz at three quarters', () => {
    expect(passed(3, 4)).toBe(true);
    expect(passed(2, 4)).toBe(false);
    expect(passed(undefined, 4)).toBe(false);
    expect(passed(0, 0)).toBe(false);
  });
});

describe('the week plan', () => {
  it('runs from week 0 to week 25 with no gaps, each in a known part with goals and pages', () => {
    expect(WEEKS.map((w) => w.n)).toEqual(Array.from({ length: 26 }, (_, i) => i));
    for (const w of WEEKS) {
      expect(PARTS).toContain(w.part);
      expect(w.goals.length).toBeGreaterThan(0);
      expect(w.pages.length).toBeGreaterThan(0);
    }
  });
});

describe('the quizzes', () => {
  it('give every week at least four questions, each with a valid answer and an explanation', async () => {
    const { ALL_QUIZ, quizFor } = await import('./quizzes');
    for (const w of WEEKS) expect(quizFor(w.n).length, `week ${w.n}`).toBeGreaterThanOrEqual(4);
    for (const q of ALL_QUIZ) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
      expect(q.why.length).toBeGreaterThan(0);
    }
    expect(new Set(ALL_QUIZ.map((q) => q.q)).size).toBe(ALL_QUIZ.length);
  });
});

describe('where each week sends the learner', () => {
  it('names a folder that exists in examples/ml-course for every week, with the capstone for week 25', async () => {
    const { exerciseFor } = await import('./weeks');
    const files = Object.keys(import.meta.glob('../../../../examples/ml-course/*/*.py'));
    const folders = new Set(files.map((f) => f.split('/').slice(-2, -1)[0]));
    for (const w of WEEKS) expect(folders, `week ${w.n}`).toContain(exerciseFor(w.n).folder);
    expect(exerciseFor(25).folder).toBe('capstone');
  });
});

describe('saving from two tabs', () => {
  it('keeps both tabs’ changes, because each change applies to what is saved now', async () => {
    const { commit } = await import('./progress');
    const shared = memory();
    const tabA = load(shared);
    const tabB = load(shared);
    commit((p) => recordScore(p, 4, 4), tabA, shared);
    const after = commit((p) => toggleDone(p, 5), tabB, shared);
    expect(after).toEqual({ done: [5], best: { 4: 4 } });
  });

  it('still remembers this visit when storage cannot be read', async () => {
    const { commit } = await import('./progress');
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const first = commit((p) => toggleDone(p, 1), EMPTY, blocked);
    expect(commit((p) => toggleDone(p, 2), first, blocked).done).toEqual([1, 2]);
  });
});
