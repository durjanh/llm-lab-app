import { describe, expect, it } from 'vitest';
import { acquisition, cholesky, fitGP, mulberry32, normCdf, samplePosterior, solveLower, solveUpper } from './gp';
import {
  bayesSearch,
  fullTraining,
  hidden2d,
  makeConfigs,
  meanCurve,
  randomSearch,
  randomVersusGrid,
  successiveHalving,
} from './search';
import { QUIZ } from './quiz';

describe('linear algebra', () => {
  it('Cholesky factors reproduce the matrix and solve a system', () => {
    const A = [
      [4, 2, 0.4],
      [2, 5, 1],
      [0.4, 1, 3],
    ];
    const L = cholesky(A);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += L[i][k] * L[j][k];
        expect(s).toBeCloseTo(A[i][j], 10);
      }
    const x = solveUpper(L, solveLower(L, [1, 2, 3]));
    const back = A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
    expect(back[0]).toBeCloseTo(1, 10);
    expect(back[2]).toBeCloseTo(3, 10);
  });

  it('refuses a matrix that is not positive definite', () => {
    expect(() =>
      cholesky([
        [1, 2],
        [2, 1],
      ]),
    ).toThrow();
  });

  it('the normal CDF is accurate', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe('Gaussian process', () => {
  const kernel = { lengthScale: 0.15, signalVar: 1, noise: 1e-6 };
  const X = [[0.1], [0.4], [0.8]];
  const y = [1, 3, 2];

  it('passes through noise-free observations with almost no spread there', () => {
    const gp = fitGP(X, y, kernel);
    X.forEach((x, i) => {
      const p = gp.predict(x);
      expect(p.mean).toBeCloseTo(y[i], 2);
      expect(p.sd).toBeLessThan(0.02);
    });
  });

  it('is unsure far from the data', () => {
    const gp = fitGP(X, y, kernel);
    expect(gp.predict([0.6]).sd).toBeGreaterThan(gp.predict([0.41]).sd);
  });

  it('more noise lets the mean miss the points', () => {
    const gp = fitGP(X, y, { ...kernel, noise: 1 });
    expect(Math.abs(gp.predict([0.4]).mean - 3)).toBeGreaterThan(0.2);
  });

  it('with no data, predicts the prior', () => {
    const p = fitGP([], [], kernel).predict([0.5]);
    expect(p.mean).toBe(0);
    expect(p.sd).toBeCloseTo(1, 6);
  });

  it('posterior samples pass close to the observations and are repeatable', () => {
    const gp = fitGP(X, y, kernel);
    const xs = [0.1, 0.25, 0.4, 0.6, 0.8];
    const a = samplePosterior(gp, xs, 3, 7);
    expect(a).toEqual(samplePosterior(gp, xs, 3, 7));
    for (const s of a) expect(s[2]).toBeCloseTo(3, 1);
  });

  it('acquisition functions favour high means and high uncertainty', () => {
    const best = 1;
    const sure = { mean: 1.2, sd: 0.01 };
    const unsure = { mean: 0.9, sd: 0.5 };
    expect(acquisition('pi', sure, best)).toBeGreaterThan(acquisition('pi', unsure, best));
    expect(acquisition('ucb', unsure, best, { kappa: 3 })).toBeGreaterThan(
      acquisition('ucb', sure, best, { kappa: 3 }),
    );
    expect(acquisition('ucb', sure, best, { kappa: 0 })).toBeGreaterThan(
      acquisition('ucb', unsure, best, { kappa: 0 }),
    );
    expect(acquisition('ei', { mean: 0, sd: 0 }, best)).toBe(0);
  });
});

describe('grid against random search', () => {
  it('random search finds a lower loss on average when one hyperparameter matters', () => {
    const r = randomVersusGrid(3);
    expect(r.random).toBeLessThan(r.grid);
    expect(r.randomWins).toBeGreaterThan(0.5);
  });
});

describe('successive halving', () => {
  const configs = makeConfigs(27, 3);

  it('narrows the field and spends far less than training everything fully', () => {
    const r = successiveHalving(configs, 1, 3, 27, 5);
    expect(r.rounds[0].survivors).toHaveLength(27);
    expect(r.rounds[r.rounds.length - 1].survivors.length).toBeLessThanOrEqual(3);
    expect(r.totalEpochs).toBeLessThan(27 * 27);
  });

  it('with the same budget, finds a configuration at least as good as full training of a few', () => {
    const r = successiveHalving(configs, 1, 3, 27, 5);
    const full = fullTraining(configs, r.totalEpochs, 27);
    expect(r.chosen.final).toBeLessThanOrEqual(full.chosen.final + 1e-9);
    expect(r.bestPossible.final).toBeLessThanOrEqual(r.chosen.final);
  });
});

describe('Bayesian optimisation in two dimensions', () => {
  it('the hidden function peaks near 1.01', () => {
    expect(hidden2d([0.78, 0.27])).toBeGreaterThan(1);
    expect(hidden2d([0.25, 0.7])).toBeLessThan(0.82);
  });

  it('on average beats random search with the same budget', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const runs = seeds.map((s) => bayesSearch(25, s));
    const bo = meanCurve(runs);
    const rnd = meanCurve(seeds.map((s) => randomSearch(25, s)));
    expect(bo[24]).toBeGreaterThan(rnd[24] + 0.1);
    // Every run climbs at least the broad hill; only some find the narrow, taller peak.
    for (const r of runs) expect(r.bestSoFar[24]).toBeGreaterThan(0.76);
    expect(runs.some((r) => r.bestSoFar[24] > 1)).toBe(true);
  });

  it('is repeatable', () => {
    expect(bayesSearch(8, 2).points).toEqual(bayesSearch(8, 2).points);
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });
});

describe('quiz', () => {
  it('has four questions for each of weeks 14 and 18, each with a valid answer', () => {
    for (const w of [14, 18]) expect(QUIZ.filter((q) => q.week === w)).toHaveLength(4);
    for (const q of QUIZ) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
    }
  });
});
