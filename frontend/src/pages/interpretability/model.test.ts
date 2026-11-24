import { describe, expect, it } from 'vitest';
import { DATASHEET, MODEL_CARD, answered, exampleAnswers, renderMarkdown } from './docs';
import {
  FEATURES,
  MODEL,
  POPULATION,
  SAMPLE,
  auc,
  bestOfAllThree,
  calibration,
  counterfactuals,
  gaps,
  groupStats,
  iceCurves,
  logOdds,
  makePopulation,
  matchThreshold,
  partialDependence,
  permutationImportance,
  predict,
  proxyReport,
  shapley,
} from './model';
import { QUIZ } from './quiz';

describe('the invented population and model', () => {
  it('is the same every time', () => {
    expect(makePopulation()).toEqual(POPULATION);
  });

  it('separates repayers from defaulters reasonably, but not perfectly', () => {
    const a = auc(
      POPULATION.map((x) => predict(x)),
      POPULATION.map((x) => x.repaid),
    );
    expect(a).toBeGreaterThan(0.75);
    expect(a).toBeLessThan(0.85);
  });

  it('computes AUC by rank, with ties counted half', () => {
    expect(auc([0.1, 0.4, 0.35, 0.8], [false, false, true, true])).toBeCloseTo(0.75);
    expect(auc([0.5, 0.5], [true, false])).toBe(0.5);
  });
});

describe('explanations', () => {
  it('ranks missed payments as the feature the model leans on most', () => {
    const imp = permutationImportance();
    expect(imp[0].feature).toBe('missed');
    expect(imp.every((i) => i.drop > 0)).toBe(true);
  });

  it('partial dependence is the average of the ICE curves', () => {
    const pd = partialDependence('debt');
    const ice = iceCurves('debt', POPULATION);
    pd.forEach(([, y], i) => {
      const mean = ice.reduce((s, c) => s + c[i][1], 0) / ice.length;
      expect(y).toBeCloseTo(mean, 10);
    });
    expect(pd[0][1]).toBeGreaterThan(pd[pd.length - 1][1]);
  });

  it('Shapley values add up to the prediction minus the baseline', () => {
    const s = shapley(SAMPLE);
    const total = FEATURES.reduce((t, f) => t + s.phi[f], 0);
    expect(total).toBeCloseTo(s.prediction - s.base, 10);
    expect(s.coalitions).toHaveLength(16);
  });

  it('in log-odds, a linear model’s Shapley values are weight times distance from the background mean', () => {
    const bg = POPULATION.slice(0, 150);
    const s = shapley(SAMPLE, bg, 'logOdds');
    for (const f of FEATURES) {
      const mean = bg.reduce((t, a) => t + a[f], 0) / bg.length;
      expect(s.phi[f]).toBeCloseTo(MODEL.weights[f] * (SAMPLE[f] - mean), 9);
    }
  });

  it('counterfactuals land exactly on the threshold', () => {
    expect(predict(SAMPLE)).toBeLessThan(0.5);
    for (const c of counterfactuals(SAMPLE, 0.5)) {
      expect(logOdds({ ...SAMPLE, [c.feature]: c.needed })).toBeCloseTo(0, 9);
    }
    const missed = counterfactuals(SAMPLE).find((c) => c.feature === 'missed')!;
    expect(missed.possible).toBe(false);
  });
});

describe('fairness', () => {
  it('the groups have different base rates, and one threshold approves them at different rates', () => {
    const [n, s] = groupStats(POPULATION, { North: 0.5, South: 0.5 });
    expect(n.baseRate - s.baseRate).toBeGreaterThan(0.1);
    expect(gaps([n, s]).parity).toBeGreaterThan(0.15);
  });

  it('a separate threshold can close the approval gap', () => {
    const south = matchThreshold('parity', 0.5);
    expect(south).toBeLessThan(0.5);
    expect(gaps(groupStats(POPULATION, { North: 0.5, South: south })).parity).toBeLessThan(0.02);
  });

  it('no pair of thresholds gives equal precision and equalised odds together', () => {
    expect(bestOfAllThree().gap).toBeGreaterThan(0.03);
  });

  it('calibration bins cover 0 to 1 and skip thin bins', () => {
    const bins = calibration();
    expect(bins[0].lo).toBe(0);
    expect(bins[bins.length - 1].hi).toBe(1);
    for (const b of bins)
      for (const g of ['North', 'South'] as const) expect(b.observed[g] === null).toBe(b.predicted[g] === null);
  });

  it('years at address is a proxy for the area, and dropping it narrows the gap for almost no loss', () => {
    const r = proxyReport('years');
    expect(Math.abs(r.correlations.years)).toBeGreaterThan(0.3);
    expect(r.approvalGapWithout).toBeLessThan(r.approvalGap * 0.6);
    expect(r.approvalGapWithout).toBeGreaterThan(0.05);
    expect(r.aucWith - r.aucWithout).toBeLessThan(0.01);
  });
});

describe('documentation', () => {
  it('the worked model card quotes numbers the model really gives', () => {
    const [n, s] = groupStats(POPULATION, { North: 0.5, South: 0.5 });
    expect(Math.round(n.selection * 100)).toBe(75);
    expect(Math.round(s.selection * 100)).toBe(53);
    expect(Math.round(n.ppv * 100)).toBe(78);
    expect(Math.round(s.ppv * 100)).toBe(70);
    expect(
      auc(
        POPULATION.map((x) => predict(x)),
        POPULATION.map((x) => x.repaid),
      ).toFixed(2),
    ).toBe('0.79');
    expect(Math.abs(proxyReport().correlations.years).toFixed(2)).toBe('0.36');
  });

  it('renders every question, marking the unanswered ones', () => {
    const md = renderMarkdown('Model card', MODEL_CARD, { name: 'loan-repay v3' });
    expect(md).toContain('# Model card');
    expect(md).toContain('loan-repay v3');
    expect(md).toContain('_Not answered yet._');
    expect(answered(MODEL_CARD, { name: 'x', owner: '  ' })).toEqual({ done: 1, total: 8 });
    const full = exampleAnswers(DATASHEET);
    expect(answered(DATASHEET, full).done).toBe(answered(DATASHEET, full).total);
  });
});

describe('quiz', () => {
  it('has six week-21 questions, each with a valid answer', () => {
    expect(QUIZ).toHaveLength(6);
    for (const q of QUIZ) {
      expect(q.week).toBe(21);
      expect(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length).toBe(true);
    }
  });
});
