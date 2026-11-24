import { describe, expect, it } from 'vitest';
import { QUIZ } from './quizExisting';

const WEEKS = [0, 3, 9, 10, 11, 12, 13, 15, 16, 17, 19, 20, 22, 23];

describe('quiz for the weeks taught by existing pages', () => {
  it('has four questions for each of its weeks and none for others', () => {
    for (const w of WEEKS) expect(QUIZ.filter((q) => q.week === w)).toHaveLength(4);
    expect(QUIZ).toHaveLength(WEEKS.length * 4);
  });

  it('points every answer at a real option, with at least three options and an explanation', () => {
    for (const q of QUIZ) {
      expect(q.options.length).toBeGreaterThanOrEqual(3);
      expect(Number.isInteger(q.answer)).toBe(true);
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
      expect(q.why.length).toBeGreaterThan(20);
    }
  });

  it('has no repeated question or repeated option within a question', () => {
    expect(new Set(QUIZ.map((q) => q.q)).size).toBe(QUIZ.length);
    for (const q of QUIZ) expect(new Set(q.options).size).toBe(q.options.length);
  });
});
