/* The LLMOps page's arithmetic, kept free of React so it can be tested: the release pipeline with an injected
   failure, the autoscaling day, the A/B sample size and significance check, the guardrail verdict and the
   peeking simulation. All figures are invented. */

// ---------- the release pipeline ----------

export type StageId = 'pr' | 'unit' | 'evals' | 'build' | 'scan' | 'staging' | 'smoke' | 'canary' | 'promote';
export type StageStatus = 'passed' | 'failed' | 'skipped' | 'rolled-back';

export const STAGE_ORDER: StageId[] = ['pr', 'unit', 'evals', 'build', 'scan', 'staging', 'smoke', 'canary', 'promote'];

export interface PipelineRun {
  statuses: Record<StageId, StageStatus>;
  /** The stage that stopped the release, or null when it reached production. */
  stoppedAt: StageId | null;
  /** True when the new version had live traffic and was taken off it again. */
  rolledBack: boolean;
}

/**
 * Runs the pipeline with one stage made to fail (or none). Stages before it pass and stages after it never run,
 * except that a failed canary rolls back: the promote stage then sends all traffic back to the old version.
 */
export function runPipeline(failAt: StageId | null): PipelineRun {
  const at = failAt ? STAGE_ORDER.indexOf(failAt) : -1;
  const statuses = {} as Record<StageId, StageStatus>;
  STAGE_ORDER.forEach((id, i) => {
    statuses[id] = at < 0 || i < at ? 'passed' : i === at ? 'failed' : 'skipped';
  });
  const rolledBack = failAt === 'canary';
  if (rolledBack) statuses.promote = 'rolled-back';
  return { statuses, stoppedAt: failAt, rolledBack };
}

// ---------- normal distribution helpers ----------

/** The standard normal cumulative distribution, from the error function (Abramowitz and Stegun 7.1.26). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** The standard normal quantile (inverse cumulative distribution), by Acklam's rational approximation. */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be between 0 and 1');
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

// ---------- A/B testing ----------

/**
 * Users needed in each arm to detect a change from rate p1 to p1 + mde with a two-sided test at the given alpha
 * and power (the usual two-proportion formula). Returns null when the inputs cannot describe a test.
 */
export function sampleSize(p1: number, mde: number, alpha: number, power: number): number | null {
  const p2 = p1 + mde;
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1 && mde !== 0 && alpha > 0 && alpha < 1 && power > 0 && power < 1))
    return null;
  const za = normInv(1 - alpha / 2);
  const zb = normInv(power);
  const pBar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pBar * (1 - pBar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / (mde * mde));
}

export interface ZTest {
  rateA: number;
  rateB: number;
  /** B's rate minus A's. */
  diff: number;
  z: number;
  /** Two-sided p-value. */
  p: number;
  /** Confidence interval for the difference, at 1 - alpha. */
  low: number;
  high: number;
  significant: boolean;
}

/**
 * A two-proportion z-test of B against A: the pooled standard error for the test, the unpooled one for the
 * confidence interval. Returns null when either arm is empty or the counts are impossible.
 */
export function zTest(successA: number, nA: number, successB: number, nB: number, alpha = 0.05): ZTest | null {
  const valid = (s: number, n: number) => Number.isFinite(s) && Number.isFinite(n) && n > 0 && s >= 0 && s <= n;
  if (!valid(successA, nA) || !valid(successB, nB) || !(alpha > 0 && alpha < 1)) return null;
  const rateA = successA / nA;
  const rateB = successB / nB;
  const diff = rateB - rateA;
  const pooled = (successA + successB) / (nA + nB);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  const z = sePooled > 0 ? diff / sePooled : 0;
  const p = sePooled > 0 ? 2 * (1 - normCdf(Math.abs(z))) : 1;
  const se = Math.sqrt((rateA * (1 - rateA)) / nA + (rateB * (1 - rateB)) / nB);
  const zc = normInv(1 - alpha / 2);
  return { rateA, rateB, diff, z, p, low: diff - zc * se, high: diff + zc * se, significant: p < alpha };
}

export interface Guardrails {
  costA: number;
  costB: number;
  p95A: number;
  p95B: number;
  /** Refusal rates as fractions. */
  refusalA: number;
  refusalB: number;
}

export interface GuardrailLimits {
  /** Largest allowed rise in cost per task, as a fraction (0.1 = 10%). */
  cost: number;
  /** Largest allowed rise in p95 latency, as a fraction. */
  p95: number;
  /** Largest allowed rise in refusal rate, in percentage points as a fraction (0.01 = 1 point). */
  refusal: number;
}

export interface Verdict {
  decision: 'ship' | 'vetoed' | 'no-difference' | 'worse' | 'invalid';
  /** The guardrails B breaks, in words. */
  broken: string[];
}

/** Whether to ship B: it must win on the main metric with significance and break no guardrail. */
export function verdict(test: ZTest | null, g: Guardrails, limits: GuardrailLimits): Verdict {
  if (!test) return { decision: 'invalid', broken: [] };
  const broken: string[] = [];
  if (g.costA > 0 && g.costB > g.costA * (1 + limits.cost)) broken.push('cost per task');
  if (g.p95A > 0 && g.p95B > g.p95A * (1 + limits.p95)) broken.push('p95 latency');
  if (g.refusalB > g.refusalA + limits.refusal) broken.push('refusal rate');
  if (!test.significant) return { decision: 'no-difference', broken };
  if (test.diff < 0) return { decision: 'worse', broken };
  return { decision: broken.length ? 'vetoed' : 'ship', broken };
}

/** A small seeded random number generator (mulberry32), so a simulation gives the same result every time. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PeekResult {
  tests: number;
  /** A/A tests called significant at the end only. */
  endOnly: number;
  /** A/A tests called significant on any day's look. */
  daily: number;
  /** A/A tests called significant on any day's look with the stricter per-look threshold. */
  dailyStrict: number;
}

/**
 * A/A tests (both arms identical, so every "winner" is a false positive), checked once at the end and every day.
 * Each day adds `perDay` users to each arm with success rate `rate`.
 */
export function peekingSimulation(
  seed: number,
  tests: number,
  days: number,
  perDay: number,
  rate: number,
  alpha = 0.05,
  strictAlpha = 0.01,
): PeekResult {
  const rand = rng(seed);
  const out: PeekResult = { tests, endOnly: 0, daily: 0, dailyStrict: 0 };
  for (let t = 0; t < tests; t++) {
    let sa = 0;
    let sb = 0;
    let n = 0;
    let anyDay = false;
    let anyStrict = false;
    let last: ZTest | null = null;
    for (let d = 0; d < days; d++) {
      for (let i = 0; i < perDay; i++) {
        if (rand() < rate) sa++;
        if (rand() < rate) sb++;
      }
      n += perDay;
      last = zTest(sa, n, sb, n, alpha);
      if (last && last.p < alpha) anyDay = true;
      if (last && last.p < strictAlpha) anyStrict = true;
    }
    if (last?.significant) out.endOnly++;
    if (anyDay) out.daily++;
    if (anyStrict) out.dailyStrict++;
  }
  return out;
}

// ---------- autoscaling ----------

export interface ScaleParams {
  minReplicas: number;
  maxReplicas: number;
  /** The utilisation the autoscaler aims for, as a fraction (0.6 = 60%). */
  target: number;
  /** Minutes from a pod being asked for to it passing its readiness probe. */
  startupMinutes: number;
  /** Most new pods the autoscaler may add in one minute. */
  maxStepUp: number;
  /** 'inflight' scales on requests in progress per pod; 'cpu' on CPU, which an I/O-bound AI service barely uses. */
  metric: 'inflight' | 'cpu';
  /** Requests a second the model deployment accepts before it answers 429. */
  modelLimit: number;
}

/** Requests a second one pod serves: 16 concurrent slots, each request held about 4 seconds by the model call. */
export const POD_RPS = 4;
/** p95 of the model call itself, in seconds, before any queueing in the pod. */
export const BASE_P95 = 4;
/** The latency objective, in seconds. */
export const SLO_P95 = 8;
/** Invented price of one pod (1 vCPU, 2 GiB) for an hour, in pounds. */
export const POD_HOUR = 0.12;
/** A waiting request times out after this many seconds. */
const TIMEOUT = 60;
/** CPU an I/O-bound pod uses for a given share of its request slots: it mostly waits on the model. */
const CPU_PER_UTIL = 0.3;
/** Minutes the autoscaler waits before it removes pods, so a dip does not shrink the fleet (Kubernetes' default). */
const DOWN_WINDOW = 5;

export const SCALE_DEFAULTS: ScaleParams = {
  minReplicas: 3,
  maxReplicas: 20,
  target: 0.6,
  startupMinutes: 2,
  maxStepUp: 4,
  metric: 'inflight',
  modelLimit: 30,
};

/** Invented traffic for one working day, in requests a second at minute m: two peaks and a newsletter at 13:00. */
export function traffic(minute: number): number {
  const h = minute / 60;
  const bump = (centre: number, width: number, height: number) =>
    height * Math.exp(-((h - centre) ** 2) / (2 * width * width));
  const newsletter = minute >= 13 * 60 && minute < 13 * 60 + 25 ? 22 * (1 - (minute - 13 * 60) / 25) : 0;
  return 1.5 + bump(10, 1.6, 18) + bump(15, 2, 14) + newsletter;
}

export interface ScaleDay {
  load: number[];
  /** Ready pods each minute. */
  pods: number[];
  /** p95 latency each minute, in seconds. */
  p95: number[];
  podHours: number;
  cost: number;
  minutesOverSlo: number;
  timedOut: number;
  /** Requests the model refused (429) because the deployment's own limit was reached, whatever the pods. */
  rateLimited: number;
  peakPods: number;
}

/** Simulates one day, minute by minute: traffic, the autoscaler, pods starting, a queue in front of them. */
export function simulateDay(p: ScaleParams): ScaleDay {
  const minutes = 24 * 60;
  const min = Math.max(1, Math.round(p.minReplicas));
  const max = Math.max(min, Math.round(p.maxReplicas));
  const target = Math.min(0.95, Math.max(0.1, p.target));
  const startup = Math.max(0, Math.round(p.startupMinutes));
  const step = Math.max(1, Math.round(p.maxStepUp));
  let ready = min;
  let starting: number[] = []; // the minute each pending pod becomes ready
  let backlog = 0;
  let lowSince = -1;
  const out: ScaleDay = {
    load: [],
    pods: [],
    p95: [],
    podHours: 0,
    cost: 0,
    minutesOverSlo: 0,
    timedOut: 0,
    rateLimited: 0,
    peakPods: min,
  };
  for (let m = 0; m < minutes; m++) {
    ready += starting.filter((at) => at <= m).length;
    starting = starting.filter((at) => at > m);

    const offered = traffic(m);
    const accepted = Math.min(offered, p.modelLimit);
    out.rateLimited += (offered - accepted) * 60;
    const capacity = ready * POD_RPS * 60; // requests this minute
    const demand = accepted * 60 + backlog;
    backlog = Math.max(0, demand - capacity);
    const limit = (TIMEOUT / 60) * capacity; // what can wait less than the timeout
    if (backlog > limit) {
      out.timedOut += backlog - limit;
      backlog = limit;
    }
    const util = Math.min(1, accepted / (ready * POD_RPS));
    const wait = (backlog / capacity) * 60;
    const p95 = BASE_P95 + wait + (util > 0.8 ? (util - 0.8) * 10 : 0);

    out.load.push(offered);
    out.pods.push(ready);
    out.p95.push(p95);
    if (p95 > SLO_P95) out.minutesOverSlo++;
    out.podHours += (ready + starting.length) / 60;
    out.peakPods = Math.max(out.peakPods, ready + starting.length);

    // The autoscaler: desired = ceil(pods × observed ÷ target), as the Kubernetes HPA computes it.
    const inflight = Math.min(1.5, (accepted * 60 + backlog) / Math.max(1, ready * POD_RPS * 60));
    const observed = p.metric === 'cpu' ? Math.min(1, inflight) * CPU_PER_UTIL : inflight;
    const current = ready + starting.length;
    const desired = Math.min(max, Math.max(min, Math.ceil((ready * observed) / target)));
    if (desired > current) {
      const add = Math.min(step, desired - current);
      for (let i = 0; i < add; i++) starting.push(m + startup);
      lowSince = -1;
    } else if (desired < ready) {
      if (lowSince < 0) lowSince = m;
      if (m - lowSince >= DOWN_WINDOW) {
        ready = Math.max(desired, min);
        lowSince = -1;
      }
    } else {
      lowSince = -1;
    }
  }
  out.cost = out.podHours * POD_HOUR;
  return out;
}
