import { describe, expect, it } from 'vitest';
import {
  SCALE_DEFAULTS,
  normCdf,
  normInv,
  peekingSimulation,
  runPipeline,
  sampleSize,
  simulateDay,
  verdict,
  zTest,
} from './llmops';

describe('runPipeline', () => {
  it('passes every stage when nothing fails', () => {
    const r = runPipeline(null);
    expect(Object.values(r.statuses).every((s) => s === 'passed')).toBe(true);
    expect(r.stoppedAt).toBeNull();
    expect(r.rolledBack).toBe(false);
  });

  it('stops at the failed stage and runs nothing after it', () => {
    const r = runPipeline('evals');
    expect(r.statuses.unit).toBe('passed');
    expect(r.statuses.evals).toBe('failed');
    expect(r.statuses.build).toBe('skipped');
    expect(r.statuses.promote).toBe('skipped');
    expect(r.rolledBack).toBe(false);
  });

  it('rolls back when the canary fails, because it already had live traffic', () => {
    const r = runPipeline('canary');
    expect(r.statuses.canary).toBe('failed');
    expect(r.statuses.promote).toBe('rolled-back');
    expect(r.rolledBack).toBe(true);
  });
});

describe('normal distribution', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
    expect(normInv(0.8)).toBeCloseTo(0.841621, 4);
    expect(normInv(0.001)).toBeCloseTo(-3.090232, 4);
  });

  it('refuses probabilities outside (0, 1)', () => {
    expect(() => normInv(0)).toThrow(RangeError);
    expect(() => normInv(1)).toThrow(RangeError);
  });
});

describe('sampleSize', () => {
  it('gives the textbook figure for 30% to 33% at 5% alpha and 80% power', () => {
    // The standard two-proportion formula gives about 3,760 per arm.
    const n = sampleSize(0.3, 0.03, 0.05, 0.8)!;
    expect(n).toBeGreaterThan(3700);
    expect(n).toBeLessThan(3820);
  });

  it('needs four times the users to detect half the effect', () => {
    const big = sampleSize(0.3, 0.04, 0.05, 0.8)!;
    const small = sampleSize(0.3, 0.02, 0.05, 0.8)!;
    expect(small / big).toBeGreaterThan(3.7);
    expect(small / big).toBeLessThan(4.3);
  });

  it('returns null for inputs that describe no test', () => {
    expect(sampleSize(0.3, 0, 0.05, 0.8)).toBeNull();
    expect(sampleSize(0.98, 0.05, 0.05, 0.8)).toBeNull();
    expect(sampleSize(0.3, 0.03, 0, 0.8)).toBeNull();
    expect(sampleSize(Number.NaN, 0.03, 0.05, 0.8)).toBeNull();
  });
});

describe('zTest', () => {
  it('finds a clear difference significant', () => {
    const t = zTest(600, 2000, 700, 2000)!;
    expect(t.diff).toBeCloseTo(0.05, 6);
    expect(t.significant).toBe(true);
    expect(t.low).toBeGreaterThan(0);
  });

  it('does not call a small difference on small samples significant', () => {
    const t = zTest(30, 100, 33, 100)!;
    expect(t.significant).toBe(false);
    expect(t.low).toBeLessThan(0);
    expect(t.high).toBeGreaterThan(0);
  });

  it('handles identical all-or-nothing arms without dividing by zero', () => {
    const t = zTest(0, 50, 0, 50)!;
    expect(t.p).toBe(1);
    expect(t.significant).toBe(false);
  });

  it('returns null for empty arms or more successes than users', () => {
    expect(zTest(1, 0, 1, 10)).toBeNull();
    expect(zTest(11, 10, 1, 10)).toBeNull();
    expect(zTest(-1, 10, 1, 10)).toBeNull();
  });
});

describe('verdict', () => {
  const g = { costA: 0.01, costB: 0.0105, p95A: 5, p95B: 5.2, refusalA: 0.01, refusalB: 0.012 };
  const limits = { cost: 0.1, p95: 0.2, refusal: 0.01 };
  const win = zTest(600, 2000, 700, 2000);

  it('ships a significant winner that keeps every guardrail', () => {
    expect(verdict(win, g, limits).decision).toBe('ship');
  });

  it('vetoes a winner that costs too much or refuses too often', () => {
    const v = verdict(win, { ...g, costB: 0.02, refusalB: 0.05 }, limits);
    expect(v.decision).toBe('vetoed');
    expect(v.broken).toEqual(['cost per task', 'refusal rate']);
  });

  it('reports no difference, a loser, and invalid counts', () => {
    expect(verdict(zTest(30, 100, 33, 100), g, limits).decision).toBe('no-difference');
    expect(verdict(zTest(700, 2000, 600, 2000), g, limits).decision).toBe('worse');
    expect(verdict(null, g, limits).decision).toBe('invalid');
  });
});

describe('peekingSimulation', () => {
  it('is deterministic for a seed', () => {
    expect(peekingSimulation(7, 40, 10, 200, 0.3)).toEqual(peekingSimulation(7, 40, 10, 200, 0.3));
  });

  it('finds far more false winners when it looks every day', () => {
    const r = peekingSimulation(42, 300, 14, 300, 0.3);
    expect(r.endOnly / r.tests).toBeLessThan(0.1);
    expect(r.daily).toBeGreaterThan(r.endOnly * 2);
    expect(r.dailyStrict).toBeLessThan(r.daily);
  });
});

describe('simulateDay', () => {
  it('keeps latency within the objective at the defaults, apart from the model limit', () => {
    const d = simulateDay(SCALE_DEFAULTS);
    expect(d.load).toHaveLength(1440);
    expect(d.minutesOverSlo).toBeLessThan(30);
    expect(d.peakPods).toBeLessThanOrEqual(SCALE_DEFAULTS.maxReplicas);
    expect(d.rateLimited).toBeGreaterThan(0); // the newsletter spike passes the model's limit
  });

  it('breaks the objective when it scales on CPU, which an I/O-bound service hardly uses', () => {
    const cpu = simulateDay({ ...SCALE_DEFAULTS, metric: 'cpu' });
    const inflight = simulateDay(SCALE_DEFAULTS);
    expect(cpu.minutesOverSlo).toBeGreaterThan(inflight.minutesOverSlo + 60);
    expect(cpu.timedOut).toBeGreaterThan(inflight.timedOut);
  });

  it('costs more when the minimum is set to the peak', () => {
    const flat = simulateDay({ ...SCALE_DEFAULTS, minReplicas: 20 });
    expect(flat.cost).toBeGreaterThan(simulateDay(SCALE_DEFAULTS).cost * 2);
    expect(flat.minutesOverSlo).toBe(0);
  });

  it('adding pods does not lift the model limit', () => {
    const many = simulateDay({ ...SCALE_DEFAULTS, minReplicas: 20 });
    expect(many.rateLimited).toBeCloseTo(simulateDay(SCALE_DEFAULTS).rateLimited, 6);
  });

  it('slow start-up and a minimum of one pod miss the morning ramp', () => {
    const slow = simulateDay({ ...SCALE_DEFAULTS, minReplicas: 1, startupMinutes: 10, maxStepUp: 1 });
    expect(slow.minutesOverSlo).toBeGreaterThan(simulateDay(SCALE_DEFAULTS).minutesOverSlo);
  });
});
