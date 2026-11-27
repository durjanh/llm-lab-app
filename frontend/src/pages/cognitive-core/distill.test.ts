import { describe, expect, it } from 'vitest';
import { accuracy, compare, points, rng, softmax, studentProbs, teacherClass, teacherLogits, train } from './distill';

describe('distillation', () => {
  it('draws the same numbers from the same seed', () => {
    const a = rng(3);
    const b = rng(3);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(4)()).not.toBe(rng(3)());
  });

  it('softens probabilities as the temperature rises, and they always sum to one', () => {
    const cold = softmax([2, 0, -1]);
    const hot = softmax([2, 0, -1], 8);
    expect(cold.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(hot.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(hot[0]).toBeLessThan(cold[0]); // the top class gives some of its share to the others
    expect(softmax([1000, 0])[0]).toBeCloseTo(1); // large scores do not overflow
  });

  it('labels points by the teacher, whose boundaries are curved', () => {
    const p = points(50, 1);
    expect(p).toHaveLength(50);
    expect(p.every((q) => q.label === teacherClass(q.x, q.y) && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1)).toBe(true);
    expect(new Set(p.map((q) => q.label)).size).toBe(3);
    expect(teacherLogits(0, 0)).toHaveLength(3);
  });

  it('starts the student knowing nothing, then learns', () => {
    const test = points(200, 9);
    const untrained = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    expect(studentProbs(untrained, 0.3, -0.2)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const { history } = train({ train: points(24, 2), test, temperature: 0, steps: 100 });
    expect(history).toHaveLength(100);
    expect(history[99]).toBeGreaterThan(accuracy(untrained, test));
  });

  it('learns more from the teacher’s soft targets than from bare labels, most of all with few points', () => {
    const few = compare(6, 2);
    const last = (h: number[]) => h[h.length - 1];
    expect(last(few.soft.history)).toBeGreaterThan(last(few.hard.history) + 0.1);
    const many = compare(48, 2);
    expect(last(many.soft.history)).toBeGreaterThan(last(many.hard.history));
    expect(last(few.soft.history) - last(few.hard.history)).toBeGreaterThan(
      last(many.soft.history) - last(many.hard.history),
    );
    expect(compare(12, 2)).toEqual(compare(12, 2)); // seeded: the same settings always give the same picture
  });
});
