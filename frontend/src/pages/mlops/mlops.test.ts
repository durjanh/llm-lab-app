import { describe, expect, it } from 'vitest';
import {
  RUNS,
  ks,
  pitDemo,
  promotionGate,
  promotionWarnings,
  psi,
  psiBand,
  retrainDecision,
  simulateRollout,
  spendSamples,
  type RolloutInput,
} from './mlops';

describe('drift statistics', () => {
  it('gives near zero PSI and KS for the same distribution', () => {
    const { reference, current } = spendSamples(0, 1);
    expect(psi(reference, current)).toBeLessThan(0.02);
    expect(ks(reference, current)).toBeLessThan(0.05);
  });

  it('grows with the shift and crosses the usual bands', () => {
    const small = spendSamples(3, 1);
    const big = spendSamples(12, 1);
    expect(psiBand(psi(small.reference, small.current))).not.toBe('drift');
    expect(psiBand(psi(big.reference, big.current))).toBe('drift');
    expect(ks(big.reference, big.current)).toBeGreaterThan(ks(small.reference, small.current));
  });

  it('matches a hand-worked PSI', () => {
    // Two bins (edge at 5): reference 50/50, current 80/20. PSI = 0.3·ln(1.6) + (−0.3)·ln(0.4).
    const reference = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const current = [1, 2, 3, 4, 1, 2, 3, 4, 6, 7];
    const expected = 0.3 * Math.log(1.6) - 0.3 * Math.log(0.4);
    expect(psi(reference, current, 2)).toBeCloseTo(expected, 6);
  });

  it('gives KS 1 for samples that do not overlap', () => {
    expect(ks([1, 2, 3], [10, 11, 12])).toBe(1);
  });
});

describe('retraining decision', () => {
  it('does not retrain on drift alone', () => {
    expect(retrainDecision({ psi: 0.4, aucDrop: null, freshLabels: true }).action).toBe('investigate');
  });
  it('retrains on a measured drop with fresh labels, and waits without them', () => {
    expect(retrainDecision({ psi: 0.05, aucDrop: 0.05, freshLabels: true }).action).toBe('retrain');
    expect(retrainDecision({ psi: 0.05, aucDrop: 0.05, freshLabels: false }).action).toBe('wait');
  });
  it('leaves a stable model alone', () => {
    expect(retrainDecision({ psi: 0.02, aucDrop: 0.005, freshLabels: true }).action).toBe('leave');
  });
});

describe('point-in-time join', () => {
  it('shows the leaky join looking far better offline than it does in production', () => {
    const r = pitDemo();
    expect(r.leakyOffline).toBeGreaterThan(0.95);
    expect(r.pitOffline).toBeGreaterThan(0.6);
    expect(r.pitOffline).toBeLessThan(0.85);
    expect(r.leakyInProduction).toBeLessThan(r.pitOffline);
  });
  it('is repeatable', () => {
    expect(pitDemo()).toEqual(pitDemo());
  });
  it('gives the figures the README and Bible quote', () => {
    const r = pitDemo();
    expect((r.leakyOffline * 100).toFixed(1)).toBe('99.7');
    expect((r.leakyInProduction * 100).toFixed(1)).toBe('70.8');
  });
});

describe('rollouts', () => {
  const base: RolloutInput = {
    strategy: 'canary',
    startShare: 5,
    oldErrorRate: 0.01,
    newErrorRate: 0.01,
    oldLatencyMs: 120,
    newLatencyMs: 100,
    rollbackAt: 0.03,
  };

  it('ramps a healthy canary to all traffic without rolling back', () => {
    const r = simulateRollout(base);
    expect(r.rolledBackAt).toBeNull();
    expect(r.series[r.series.length - 1].newShare).toBe(1);
  });

  it('rolls back a bad canary while few users have seen it', () => {
    const canary = simulateRollout({ ...base, newErrorRate: 0.08 });
    const blueGreen = simulateRollout({ ...base, strategy: 'blue-green', newErrorRate: 0.08 });
    expect(canary.rolledBackAt).not.toBeNull();
    expect(blueGreen.rolledBackAt).not.toBeNull();
    expect(canary.newModelUserErrors).toBeLessThan(blueGreen.newModelUserErrors);
    expect(canary.series[canary.series.length - 1].newShare).toBe(0);
  });

  it('shows users nothing from a shadow model but pays for every copy', () => {
    const r = simulateRollout({ ...base, strategy: 'shadow', newErrorRate: 0.2 });
    expect(r.newModelUserErrors).toBe(0);
    expect(r.rolledBackAt).toBeNull();
    expect(r.extraCalls).toBe(1);
    expect(r.series[r.series.length - 1].newErrorRate).toBeGreaterThan(0.15);
  });

  it('holds an A/B split fixed', () => {
    const r = simulateRollout({ ...base, strategy: 'ab', startShare: 50 });
    expect(r.series.every((m) => m.newShare === 0.5)).toBe(true);
  });
});

describe('promotion', () => {
  it('still warns about an old data version when no run is on the current data', () => {
    const old = RUNS.filter((r) => r.id === 'run-e88');
    expect(() => promotionWarnings(old[0], old)).not.toThrow();
    expect(promotionWarnings(old[0], old).map((w) => w.level)).toContain('bad');
  });

  it('flags a run chosen by test score, and one on old data', () => {
    const byTest = RUNS.find((r) => r.id === 'run-d19')!;
    const oldData = RUNS.find((r) => r.id === 'run-e88')!;
    const right = RUNS.find((r) => r.id === 'run-c52')!;
    expect(promotionWarnings(byTest).some((w) => w.level === 'bad' && w.text.includes('test score'))).toBe(true);
    expect(promotionWarnings(oldData).some((w) => w.level === 'bad' && w.text.includes('churn-v6'))).toBe(true);
    expect(promotionWarnings(right).every((w) => w.level === 'ok')).toBe(true);
  });

  it('passes the gate only when every check passes', () => {
    const good = {
      auc: 0.823,
      minAuc: 0.8,
      sliceGap: 0.04,
      maxSliceGap: 0.05,
      p95LatencyMs: 80,
      maxLatencyMs: 150,
      championAuc: 0.812,
      signedOff: true,
    };
    expect(promotionGate(good).every((c) => c.pass)).toBe(true);
    expect(promotionGate({ ...good, signedOff: false }).every((c) => c.pass)).toBe(false);
    expect(promotionGate({ ...good, sliceGap: 0.09 }).find((c) => c.name === 'Fair across segments')!.pass).toBe(false);
  });
});
