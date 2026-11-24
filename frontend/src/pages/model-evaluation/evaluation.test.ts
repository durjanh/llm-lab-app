import { describe, expect, it } from 'vitest';
import {
  assignFolds,
  auc,
  cheapestThreshold,
  complexityCurve,
  confusion,
  curveData,
  fitPoly,
  gains,
  imbalanced,
  imbalanceExperiment,
  learningCurve,
  metrics,
  mse,
  positivesPerFold,
  prCurve,
  repeatedCv,
  rocCurve,
  screening,
  selectionOptimism,
  timeSeriesSplits,
} from './evaluation';
import { QUIZ } from './quiz';

describe('screening data and the confusion matrix', () => {
  const d = screening(2000, 0.1, 7);

  it('has exactly the asked-for number of positives', () => {
    expect(d.labels.filter((y) => y).length).toBe(200);
  });

  it('counts add up and the metrics agree with them', () => {
    const c = confusion(d, 0.5);
    expect(c.tp + c.fp + c.tn + c.fn).toBe(2000);
    const m = metrics(c);
    expect(m.sensitivity).toBeCloseTo(c.tp / (c.tp + c.fn), 10);
    expect(m.specificity).toBeCloseTo(c.tn / (c.tn + c.fp), 10);
    expect(m.f1!).toBeCloseTo((2 * m.precision! * m.sensitivity) / (m.precision! + m.sensitivity), 10);
  });

  it('a lower threshold raises sensitivity and lowers specificity', () => {
    const lo = metrics(confusion(d, 0.4));
    const hi = metrics(confusion(d, 0.6));
    expect(lo.sensitivity).toBeGreaterThan(hi.sensitivity);
    expect(lo.specificity).toBeLessThan(hi.specificity);
  });

  it('calling everyone negative at 1% prevalence scores 99% accuracy and finds nobody', () => {
    const rare = screening(2000, 0.01, 3);
    const m = metrics(confusion(rare, 2));
    expect(m.accuracy).toBeCloseTo(0.99, 10);
    expect(m.sensitivity).toBe(0);
    expect(m.precision).toBeNull();
  });
});

describe('curves', () => {
  const d = screening(2000, 0.1, 7);

  it('ROC runs from (0, 0) to (1, 1) and the AUC is that of well-separated classes', () => {
    const roc = rocCurve(d);
    expect(roc[0]).toEqual([0, 0]);
    expect(roc[roc.length - 1]).toEqual([1, 1]);
    const a = auc(d);
    expect(a).toBeGreaterThan(0.85);
    expect(a).toBeLessThan(0.98);
  });

  it('AUC does not change with prevalence, but precision does', () => {
    const common = screening(4000, 0.2, 9);
    const rare = screening(4000, 0.02, 9);
    expect(Math.abs(auc(common) - auc(rare))).toBeLessThan(0.03);
    expect(metrics(confusion(rare, 0.5)).precision!).toBeLessThan(metrics(confusion(common, 0.5)).precision!);
  });

  it('precision–recall points are valid shares', () => {
    for (const [r, p] of prCurve(d)) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('gains start at 0, end at 1, and the top of the list has lift above 1', () => {
    const g = gains(d);
    expect(g[0].captured).toBe(0);
    expect(g[g.length - 1].captured).toBeCloseTo(1, 10);
    expect(g[2].lift).toBeGreaterThan(2);
  });

  it('when a miss costs more, the cheapest threshold is lower', () => {
    const missDear = cheapestThreshold(d, { fn: 50, fp: 1 });
    const missCheap = cheapestThreshold(d, { fn: 1, fp: 1 });
    expect(missDear.threshold).toBeLessThan(missCheap.threshold);
  });
});

describe('learning and complexity', () => {
  it('a straight line fits a straight line exactly', () => {
    const x = [-1, -0.5, 0, 0.5, 1];
    const coef = fitPoly(
      x,
      x.map((v) => 2 + 3 * v),
      1,
    );
    expect(coef[0]).toBeCloseTo(2, 4);
    expect(coef[1]).toBeCloseTo(3, 4);
  });

  it('training error falls with degree while validation error falls then rises', () => {
    const c = complexityCurve(25, [1, 3, 5, 12]);
    expect(c[3].train).toBeLessThan(c[0].train);
    expect(c[1].val).toBeLessThan(c[0].val);
    expect(c[3].val).toBeGreaterThan(c[1].val);
  });

  it('a flexible model needs more data: its validation error falls a long way with size', () => {
    const lc = learningCurve(9, [15, 200]);
    expect(lc[1].val).toBeLessThan(lc[0].val / 2);
    expect(lc[0].train).toBeLessThan(lc[0].val);
  });

  it('mse is zero for a perfect fit', () => {
    const d = curveData(5, 1, 0);
    expect(mse(fitPoly(d.x, d.y, 4, 0), d.x, d.y)).toBeLessThan(1e-6);
  });
});

describe('model selection', () => {
  it('the best of many equal models looks better on validation than it is', () => {
    const r = selectionOptimism(50, 200, 2000, 0.8, 1);
    expect(r.bestVal).toBeGreaterThan(0.84);
    expect(Math.abs(r.test - 0.8)).toBeLessThan(0.01);
  });
});

describe('cross-validation', () => {
  const small = screening(100, 0.15, 5);

  it('stratified folds share the positives evenly; plain folds may not', () => {
    const strat = positivesPerFold(small.labels, assignFolds(small.labels, 5, true, 3), 5);
    expect(Math.max(...strat) - Math.min(...strat)).toBeLessThanOrEqual(1);
    let uneven = 0;
    for (let s = 1; s <= 20; s++) {
      const plain = positivesPerFold(small.labels, assignFolds(small.labels, 5, false, s), 5);
      if (Math.max(...plain) - Math.min(...plain) > 1) uneven++;
    }
    expect(uneven).toBeGreaterThan(5);
  });

  it('every row gets exactly one fold', () => {
    const f = assignFolds(small.labels, 5, false, 2);
    expect(f).toHaveLength(100);
    for (let k = 0; k < 5; k++) expect(f.filter((v) => v === k).length).toBe(20);
  });

  it('stratified folds give a narrower spread of fold scores', () => {
    const plain = repeatedCv(small, 5, 10, false);
    const strat = repeatedCv(small, 5, 10, true);
    expect(strat.sdOfFolds).toBeLessThan(plain.sdOfFolds);
  });

  it('time-series splits only ever test on later rows', () => {
    for (const s of timeSeriesSplits(120, 4)) expect(s.testEnd).toBeGreaterThan(s.trainEnd);
  });
});

describe('imbalance and leakage', () => {
  const t = imbalanced(600, 0.06, 2);

  it('resampling after the split leaves no copies of test rows in training', () => {
    expect(imbalanceExperiment(t, 'over', false).copiesInTest).toBe(0);
  });

  it('oversampling before the split leaks copies and inflates sensitivity', () => {
    const right = imbalanceExperiment(t, 'over', false);
    const leaky = imbalanceExperiment(t, 'over', true);
    expect(leaky.copiesInTest).toBeGreaterThan(20);
    expect(leaky.sensitivity).toBeGreaterThan(right.sensitivity + 0.15);
  });

  it('undersampling before the split makes precision look far better than it is', () => {
    const right = imbalanceExperiment(t, 'under', false);
    const leaky = imbalanceExperiment(t, 'under', true);
    expect(leaky.precision!).toBeGreaterThan(right.precision! + 0.2);
  });

  it('any rebalancing finds more positives than doing nothing', () => {
    const none = imbalanceExperiment(t, 'none', false);
    for (const m of ['under', 'over', 'smote', 'weights'] as const)
      expect(imbalanceExperiment(t, m, false).sensitivity).toBeGreaterThan(none.sensitivity);
  });
});

describe('quiz', () => {
  it('has four questions for each of weeks 6, 7 and 8, each with a valid answer', () => {
    for (const w of [6, 7, 8]) expect(QUIZ.filter((q) => q.week === w)).toHaveLength(4);
    for (const q of QUIZ) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
    }
  });
});
