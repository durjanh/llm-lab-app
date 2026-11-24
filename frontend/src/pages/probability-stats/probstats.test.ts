import { describe, expect, it } from 'vitest';
import {
  CLAIM_DAYS,
  KIOSK,
  LOAF_GRAMS,
  MEMBERS,
  STOP_MINUTES,
  THREE_DICE_OVER_12,
  binomialPmf,
  bootstrapMedian,
  coinLogLik,
  compareImputation,
  entropy,
  gini,
  linearFit,
  monteCarloPi,
  naiveBayes,
  normalLogLik,
  normalMle,
  piErrorCurve,
  poissonPmf,
  quantile,
  scoreSplit,
  screening,
  sse,
  summarise,
  survey,
  threeDiceOver12,
} from './probstats';
import { QUIZ } from './quiz';

describe("Bayes' rule", () => {
  it('gives the rare-condition answer the page and quiz quote', () => {
    const s = screening(0.01, 0.9, 0.95);
    expect(s.tp).toBeCloseTo(9);
    expect(s.fp).toBeCloseTo(49.5);
    expect(s.ppv).toBeCloseTo(9 / 58.5);
    expect(s.tp + s.fn + s.fp + s.tn).toBeCloseTo(1000);
  });
});

describe('distributions and Monte Carlo', () => {
  it('has probability mass functions that sum to one', () => {
    let b = 0,
      p = 0;
    for (let k = 0; k <= 20; k++) b += binomialPmf(20, 0.3, k);
    for (let k = 0; k <= 60; k++) p += poissonPmf(4, k);
    expect(b).toBeCloseTo(1);
    expect(p).toBeCloseTo(1);
  });

  it('estimates π and the dice probability, and the error shrinks with more samples', () => {
    expect(monteCarloPi(50000).estimate).toBeCloseTo(Math.PI, 1);
    expect(THREE_DICE_OVER_12).toBeCloseTo(0.2593, 4);
    expect(Math.abs(threeDiceOver12(50000) - THREE_DICE_OVER_12)).toBeLessThan(0.01);
    const curve = piErrorCurve([100, 10000], 12);
    expect(curve[1].error).toBeLessThan(curve[0].error / 4);
  });
});

describe('summaries, likelihood, regression and the bootstrap', () => {
  it('flags a long stop by both rules, and the median barely moves', () => {
    const base = summarise(STOP_MINUTES);
    const withOutlier = summarise([...STOP_MINUTES, 40]);
    expect(base.iqrOutliers).toEqual([]);
    expect(withOutlier.iqrOutliers).toEqual([40]);
    expect(withOutlier.zOutliers).toEqual([40]);
    expect(Math.abs(withOutlier.median - base.median)).toBeLessThan(0.5);
    expect(withOutlier.mean - base.mean).toBeGreaterThan(2);
  });

  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
  });

  it('puts the coin’s likelihood peak at heads ÷ flips', () => {
    const peak = coinLogLik(14, 20, 0.7);
    for (const p of [0.5, 0.65, 0.75, 0.9]) expect(coinLogLik(14, 20, p)).toBeLessThan(peak);
  });

  it('gives the normal’s closed-form fit a higher likelihood than nearby values', () => {
    const { mu, sigma } = normalMle(LOAF_GRAMS);
    const best = normalLogLik(LOAF_GRAMS, mu, sigma);
    expect(normalLogLik(LOAF_GRAMS, mu + 1, sigma)).toBeLessThan(best);
    expect(normalLogLik(LOAF_GRAMS, mu, sigma * 1.1)).toBeLessThan(best);
    expect(normalLogLik(LOAF_GRAMS, mu, sigma * 0.9)).toBeLessThan(best);
  });

  it('fits the kiosk line with the smallest squared error', () => {
    const f = linearFit(KIOSK.temp, KIOSK.drinks);
    expect(f.slope).toBeLessThan(0);
    expect(f.r2).toBeGreaterThan(0.95);
    const best = sse(KIOSK.temp, KIOSK.drinks, f.slope, f.intercept);
    expect(sse(KIOSK.temp, KIOSK.drinks, f.slope + 0.1, f.intercept)).toBeGreaterThan(best);
    expect(sse(KIOSK.temp, KIOSK.drinks, f.slope, f.intercept + 1)).toBeGreaterThan(best);
  });

  it('gives a bootstrap interval around the median that excludes the skewed mean', () => {
    const b = bootstrapMedian(CLAIM_DAYS, 2000);
    expect(b.lo).toBeLessThanOrEqual(b.observed);
    expect(b.hi).toBeGreaterThanOrEqual(b.observed);
    expect(b.hi).toBeLessThan(12.3);
    expect(bootstrapMedian(CLAIM_DAYS, 500)).toEqual(bootstrapMedian(CLAIM_DAYS, 500));
  });
});

describe('missing data', () => {
  const bias = (mech: 'MCAR' | 'MAR' | 'MNAR') =>
    Object.fromEntries(compareImputation(survey(mech)).rows.map((r) => [r.method, r.bias]));

  it('under MCAR, dropping rows is close to the truth', () => {
    expect(Math.abs(bias('MCAR')['Drop the missing rows'])).toBeLessThan(1);
  });

  it('under MAR, dropping rows is biased and predicting from age repairs it', () => {
    const b = bias('MAR');
    expect(b['Drop the missing rows']).toBeGreaterThan(1.5);
    expect(Math.abs(b['Predict from age'])).toBeLessThan(0.5);
  });

  it('under MNAR, every method underestimates', () => {
    for (const v of Object.values(bias('MNAR'))) expect(v).toBeLessThan(-1.5);
  });

  it('mean imputation shrinks the spread', () => {
    const c = compareImputation(survey('MCAR'));
    const filled = c.rows.find((r) => r.method === 'Fill with the mean')!;
    expect(filled.sd).toBeLessThan(c.trueSd * 0.85);
  });
});

describe('entropy, Gini and splits', () => {
  it('scores pure and even nodes correctly', () => {
    expect(entropy([8, 0])).toBe(0);
    expect(entropy([8, 8])).toBeCloseTo(1);
    expect(gini([5, 0])).toBe(0);
    expect(gini([4, 4])).toBeCloseTo(0.5);
  });

  it('picks visits as the best first split by both measures', () => {
    const s = (['visits', 'plan', 'classes'] as const).map((f) => scoreSplit(MEMBERS, f));
    const byGain = [...s].sort((a, b) => b.infoGain - a.infoGain)[0];
    const byGini = [...s].sort((a, b) => b.giniDrop - a.giniDrop)[0];
    expect(byGain.feature).toBe('visits');
    expect(byGini.feature).toBe('visits');
    for (const x of s) expect(x.infoGain).toBeGreaterThan(0);
  });
});

describe('naive Bayes', () => {
  it('raises the chance of spam for spammy words and lowers it for ordinary ones', () => {
    const prior = naiveBayes([]).posterior;
    expect(prior).toBeCloseTo(5 / 12);
    expect(naiveBayes(['free', 'click']).posterior).toBeGreaterThan(0.8);
    expect(naiveBayes(['meeting', 'lunch']).posterior).toBeLessThan(prior);
  });

  it('never gives a word probability zero, thanks to smoothing', () => {
    for (const [ps, ph] of Object.values(naiveBayes([]).likelihood)) {
      expect(ps).toBeGreaterThan(0);
      expect(ph).toBeGreaterThan(0);
    }
  });
});

describe('quiz', () => {
  it('covers weeks 3, 4, 5, 10 and 12 with valid answers', () => {
    const count = (w: number) => QUIZ.filter((q) => q.week === w).length;
    expect(count(3)).toBe(2);
    for (const w of [4, 5, 10, 12]) expect(count(w)).toBe(4);
    for (const q of QUIZ) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
    }
  });
});
