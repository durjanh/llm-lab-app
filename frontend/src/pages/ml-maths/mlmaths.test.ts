import { describe, expect, it } from 'vitest';
import {
  FUNCTIONS,
  MATRIX_PRESETS,
  SURFACES,
  apply2,
  chainGraph,
  cosine,
  descend,
  det2,
  layer,
  norm,
  secantSlope,
  surfaceById,
} from './mlmaths';
import { QUIZ } from './quiz';

describe('vectors and matrices', () => {
  it('measures length and cosine similarity', () => {
    expect(norm([3, 4])).toBe(5);
    expect(cosine([1, 0], [0, 2])).toBe(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1);
    expect(cosine([1, 0], [-3, 0])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('applies a matrix by its columns and gives the presets the determinants their notes claim', () => {
    expect(
      apply2(
        [
          [2, 0],
          [0, 3],
        ],
        [1, 1],
      ),
    ).toEqual([2, 3]);
    const byName = Object.fromEntries(MATRIX_PRESETS.map((p) => [p.name, det2(p.m)]));
    expect(byName['Identity']).toBe(1);
    expect(byName['Stretch']).toBe(1);
    expect(byName['Rotate 30°']).toBeCloseTo(1);
    expect(byName['Shear']).toBe(1);
    expect(byName['Mirror']).toBe(-1);
    expect(byName['Squash flat']).toBe(0);
  });

  it('computes a layer as W·x + b with a ReLU', () => {
    const r = layer(
      [
        [1, -1],
        [2, 0],
      ],
      [1, 3],
      [0, -1],
    );
    expect(r.pre).toEqual([-2, 1]);
    expect(r.out).toEqual([0, 1]);
  });
});

describe('derivatives', () => {
  it('has exact derivatives that match a small secant', () => {
    for (const f of FUNCTIONS)
      for (const x of [-1.5, 0, 0.7, 2]) expect(secantSlope(f.f, x, 1e-5)).toBeCloseTo(f.df(x), 3);
  });

  it('gives each surface a gradient that matches finite differences', () => {
    const h = 1e-5;
    for (const s of SURFACES)
      for (const [x, y] of [
        [0.3, -0.8],
        [1.7, 1.1],
      ]) {
        const [gx, gy] = s.grad(x, y);
        expect((s.f(x + h, y) - s.f(x - h, y)) / (2 * h)).toBeCloseTo(gx, 4);
        expect((s.f(x, y + h) - s.f(x, y - h)) / (2 * h)).toBeCloseTo(gy, 4);
      }
  });

  it('backpropagates the chain graph to the same answer as a finite difference', () => {
    const [w, x, b] = [1.5, 2, -1];
    const g = chainGraph(w, x, b);
    const L = (w2: number, x2: number, b2: number) => (w2 * x2 + b2) ** 2;
    const h = 1e-6;
    expect(g.L).toBeCloseTo(4);
    expect(g.dL_dw).toBeCloseTo((L(w + h, x, b) - L(w - h, x, b)) / (2 * h), 4);
    expect(g.dL_dx).toBeCloseTo((L(w, x + h, b) - L(w, x - h, b)) / (2 * h), 4);
    expect(g.dL_db).toBeCloseTo((L(w, x, b + h) - L(w, x, b - h)) / (2 * h), 4);
  });
});

describe('descent', () => {
  it('reaches the bottom of the bowl with a sensible learning rate', () => {
    const r = descend(surfaceById('bowl'), 'gd', 0.1, 200);
    expect(r.diverged).toBe(false);
    expect(r.losses[r.losses.length - 1]).toBeLessThan(1e-6);
    expect(r.settledAt).not.toBeNull();
  });

  it('diverges on the ravine when the step is too big for its steep side', () => {
    // The steep direction has curvature 8, so any learning rate above 2/8 = 0.25 overshoots.
    expect(descend(surfaceById('ravine'), 'gd', 0.3, 100).diverged).toBe(true);
    expect(descend(surfaceById('ravine'), 'gd', 0.2, 100).diverged).toBe(false);
  });

  it('on the ravine, momentum and Adam get lower than plain descent in the same steps', () => {
    const s = surfaceById('ravine');
    const end = (r: ReturnType<typeof descend>) => r.losses[r.losses.length - 1];
    const gd = end(descend(s, 'gd', 0.05, 60));
    expect(end(descend(s, 'momentum', 0.05, 60))).toBeLessThan(gd);
    expect(end(descend(s, 'adam', 0.05, 60))).toBeLessThan(gd);
  });

  it('on two valleys, the start decides which minimum plain descent finds', () => {
    const s = surfaceById('two');
    const right = descend(s, 'gd', 0.05, 400, [2.2, 1.6]);
    const left = descend(s, 'gd', 0.05, 400, [-2.2, 1.6]);
    expect(right.path[right.path.length - 1][0]).toBeGreaterThan(0);
    expect(left.path[left.path.length - 1][0]).toBeLessThan(0);
    expect(left.losses[left.losses.length - 1]).toBeLessThan(right.losses[right.losses.length - 1]);
  });
});

describe('quiz', () => {
  it('covers weeks 1 and 2 with valid answers', () => {
    expect(new Set(QUIZ.map((q) => q.week))).toEqual(new Set([1, 2]));
    for (const q of QUIZ) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
      expect(q.why.length).toBeGreaterThan(10);
    }
  });
});
