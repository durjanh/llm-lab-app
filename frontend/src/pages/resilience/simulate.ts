/* A ten-minute simulation of requests meeting rate-limited model deployments, second by second.
 * Pure: the same workload and strategy always give the same result. */
import { rng } from '../deep-learning/kit';

export type Retry = 'none' | 'immediate' | 'backoff';
export type Counting = 'max_tokens' | 'actual';
type Dep = 'primary' | 'secondary' | 'small';

export interface Workload {
  rpm: number; // interactive requests per minute, outside the spike
  spike: number; // traffic multiplier from minute 3 to minute 6
  promptTokens: number;
  maxTokens: number;
  outputTokens: number; // what the model actually writes
  batchRpm: number; // a background job from minute 1 to minute 9; 0 for none
  primaryTpm: number;
  secondaryTpm: number;
  smallTpm: number;
  counting: Counting; // how the limiter counts a request
  outage: boolean; // the primary region stops answering from 7:00 to 8:30
}

export interface Strategy {
  retry: Retry;
  breaker: boolean;
  failover: boolean;
  smallModel: boolean;
  priority: boolean;
}

export const DURATION_S = 600;
export const SPIKE = [180, 360] as const;
export const OUTAGE = [420, 510] as const;
export const BATCH = [60, 540] as const;
export const DEADLINE_S = 60; // how long a person waits for an interactive answer
export const HANG_S = 30; // how long a request to a dead region waits before it times out
const DT = 0.25;
const BURST_S = 10; // each limiter holds ten seconds' worth of tokens
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_S = 30;
const BIN_S = 10;

export interface Series {
  t: number[]; // bin start, in minutes
  arrived: number[]; // interactive requests arriving, per bin
  served: number[]; // answered within the deadline by the large model, by arrival bin
  servedSmall: number[]; // answered by the smaller model
  failed: number[]; // no answer within the deadline
  calls: number[]; // calls sent to any deployment, per bin
  limited: number[]; // 429 responses, per bin
  p95: number[]; // 95th-percentile wait of answered interactive requests, by arrival bin (NaN when none)
}

export interface Result {
  live: number;
  liveOk: number;
  liveSmall: number;
  p50: number;
  p95: number;
  batch: number;
  batchDone: number;
  calls: number;
  limited: number;
  hung: number; // calls that hung on a dead region
  series: Series;
}

interface Req {
  t0: number;
  live: boolean;
  next: number;
  attempts: number;
  skip: Dep | null; // the deployment that just timed out: try the next one first
}

interface Deployment {
  level: number;
  cap: number;
  refill: number; // tokens per second
  failures: number;
  openUntil: number;
}

function poisson(rand: () => number, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rand();
  while (p > limit) {
    k++;
    p *= rand();
  }
  return k;
}

/** Arrival times for the workload, the same for every strategy. */
function arrivals(w: Workload): { t: number; live: boolean }[] {
  const rand = rng(7);
  const out: { t: number; live: boolean }[] = [];
  for (let t = 0; t < DURATION_S; t += DT) {
    const mult = t >= SPIKE[0] && t < SPIKE[1] ? w.spike : 1;
    for (let i = poisson(rand, (w.rpm / 60) * mult * DT); i > 0; i--) out.push({ t, live: true });
    if (w.batchRpm > 0 && t >= BATCH[0] && t < BATCH[1])
      for (let i = poisson(rand, (w.batchRpm / 60) * DT); i > 0; i--) out.push({ t, live: false });
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function simulate(w: Workload, s: Strategy): Result {
  const jitter = rng(11);
  const counted = w.promptTokens + (w.counting === 'max_tokens' ? w.maxTokens : w.outputTokens);
  const deployment = (tpm: number): Deployment => ({
    level: tpm / 6,
    cap: (tpm / 60) * BURST_S,
    refill: tpm / 60,
    failures: 0,
    openUntil: 0,
  });
  const deps: Record<Dep, Deployment> = {
    primary: deployment(w.primaryTpm),
    secondary: deployment(w.secondaryTpm),
    small: deployment(w.smallTpm),
  };
  const latency = (d: Dep) => (d === 'small' ? 0.5 + w.outputTokens / 150 : 1 + w.outputTokens / 60);

  const bins = Math.ceil(DURATION_S / BIN_S);
  const zero = () => new Array<number>(bins).fill(0);
  const series: Series = {
    t: Array.from({ length: bins }, (_, i) => (i * BIN_S) / 60),
    arrived: zero(),
    served: zero(),
    servedSmall: zero(),
    failed: zero(),
    calls: zero(),
    limited: zero(),
    p95: [],
  };
  const waitsByBin: number[][] = Array.from({ length: bins }, () => []);
  const bin = (t: number) => Math.min(bins - 1, Math.floor(t / BIN_S));

  let calls = 0,
    limited = 0,
    hung = 0,
    batchDone = 0,
    live = 0,
    batch = 0,
    liveOk = 0,
    liveSmall = 0;
  const waits: number[] = [];
  const incoming = arrivals(w);
  let nextIn = 0;
  let pending: Req[] = [];

  const finish = (r: Req, ok: boolean, end: number, via?: Dep) => {
    if (!r.live) {
      if (ok) batchDone++;
      return;
    }
    const b = bin(r.t0);
    if (ok && end - r.t0 <= DEADLINE_S) {
      liveOk++;
      waits.push(end - r.t0);
      waitsByBin[b].push(end - r.t0);
      if (via === 'small') {
        liveSmall++;
        series.servedSmall[b]++;
      } else series.served[b]++;
    } else series.failed[b]++;
  };

  for (let t = 0; t < DURATION_S; t += DT) {
    for (const d of Object.values(deps)) d.level = Math.min(d.cap, d.level + d.refill * DT);
    while (nextIn < incoming.length && incoming[nextIn].t <= t) {
      const a = incoming[nextIn++];
      pending.push({ t0: a.t, live: a.live, next: a.t, attempts: 0, skip: null });
      if (a.live) {
        live++;
        series.arrived[bin(a.t)]++;
      } else batch++;
    }

    const due = pending.filter((r) => r.next <= t);
    if (s.priority) due.sort((a, b) => Number(b.live) - Number(a.live) || a.t0 - b.t0);
    const done = new Set<Req>();
    for (const r of due) {
      if (r.live && t - r.t0 > DEADLINE_S) {
        finish(r, false, t);
        done.add(r);
        continue;
      }
      const candidates: Dep[] = ['primary'];
      if (s.failover) candidates.push('secondary');
      if (s.smallModel && r.live) candidates.push('small');
      if (r.skip && candidates.length > 1) candidates.push(...candidates.splice(candidates.indexOf(r.skip), 1));
      r.skip = null;

      let served = false,
        hanging = false,
        retryAfter = 0,
        allOpen = true,
        held = false;
      for (const name of candidates) {
        const d = deps[name];
        if (s.breaker && d.openUntil > t) continue;
        // A background request waits while the deployment has less than half its burst left.
        if (!r.live && s.priority && d.level < d.cap / 2) {
          held = true;
          continue;
        }
        allOpen = false;
        calls++;
        r.attempts++;
        series.calls[bin(t)]++;
        if (w.outage && name === 'primary' && t >= OUTAGE[0] && t < OUTAGE[1]) {
          hung++;
          d.failures++;
          if (s.breaker && d.failures >= BREAKER_FAILURES) d.openUntil = t + BREAKER_COOLDOWN_S;
          r.next = t + HANG_S;
          r.skip = 'primary';
          hanging = true;
          break;
        }
        if (d.level >= counted) {
          d.level -= counted;
          d.failures = 0;
          finish(r, true, t + latency(name), name);
          served = true;
          break;
        }
        limited++;
        series.limited[bin(t)]++;
        const wait = Math.max(1, Math.ceil((counted - d.level) / d.refill));
        retryAfter = retryAfter ? Math.min(retryAfter, wait) : wait;
        // The breaker takes the 429's Retry-After as its open time, so nobody calls this deployment until then.
        if (s.breaker) d.openUntil = t + wait;
      }
      if (served) {
        done.add(r);
        continue;
      }
      if (hanging) {
        if (s.retry === 'none' || (r.live && r.next - r.t0 > DEADLINE_S)) {
          finish(r, false, r.t0 + DEADLINE_S);
          done.add(r);
        }
        continue;
      }
      if (held && allOpen) {
        r.next = t + 1;
        continue;
      }
      const backoff = () => jitter() * Math.min(30, 2 ** Math.min(r.attempts, 6));
      if (allOpen && s.breaker) {
        // Wait for the first circuit to close, or a jittered backoff if longer, so waiters don't all wake together.
        const reopen = Math.min(...candidates.map((n) => deps[n].openUntil)) - t;
        r.next = t + Math.max(DT, reopen, backoff());
      } else if (s.retry === 'none') {
        finish(r, false, t);
        done.add(r);
        continue;
      } else if (s.retry === 'immediate') {
        if (r.attempts >= 20) {
          finish(r, false, t);
          done.add(r);
          continue;
        }
        r.next = t + DT;
      } else {
        r.next = t + Math.max(retryAfter, backoff());
      }
      if (r.live && r.next - r.t0 > DEADLINE_S) {
        finish(r, false, t); // the next try would be too late: tell the person now
        done.add(r);
      }
    }
    if (done.size) pending = pending.filter((r) => !done.has(r));
  }
  for (const r of pending) finish(r, false, DURATION_S);

  waits.sort((a, b) => a - b);
  series.p95 = waitsByBin.map((ws) =>
    quantile(
      ws.sort((a, b) => a - b),
      0.95,
    ),
  );
  return {
    live,
    liveOk,
    liveSmall,
    batch,
    batchDone,
    calls,
    limited,
    hung,
    series,
    p50: quantile(waits, 0.5),
    p95: quantile(waits, 0.95),
  };
}

export interface Rung {
  label: string;
  what: string;
  strategy: Strategy;
}

/** Each defence added on top of the one before. */
export const LADDER: Rung[] = [
  {
    label: 'No retries',
    what: 'Every 429 goes back to the user.',
    strategy: { retry: 'none', breaker: false, failover: false, smallModel: false, priority: false },
  },
  {
    label: 'Retry at once',
    what: 'Up to 20 retries, a quarter of a second apart.',
    strategy: { retry: 'immediate', breaker: false, failover: false, smallModel: false, priority: false },
  },
  {
    label: 'Backoff + Retry-After',
    what: 'Waits as long as the server asks, plus random jitter that grows.',
    strategy: { retry: 'backoff', breaker: false, failover: false, smallModel: false, priority: false },
  },
  {
    label: '+ second region',
    what: 'A second deployment of the same model, with its own quota.',
    strategy: { retry: 'backoff', breaker: false, failover: true, smallModel: false, priority: false },
  },
  {
    label: '+ smaller model',
    what: 'Interactive requests both regions refuse go to a smaller model.',
    strategy: { retry: 'backoff', breaker: false, failover: true, smallModel: true, priority: false },
  },
  {
    label: '+ circuit breaker',
    what: 'Skips a deployment that is refusing or down until it should be back.',
    strategy: { retry: 'backoff', breaker: true, failover: true, smallModel: true, priority: false },
  },
  {
    label: '+ batch waits its turn',
    what: 'The background job only sends while there is headroom.',
    strategy: { retry: 'backoff', breaker: true, failover: true, smallModel: true, priority: true },
  },
];

export const sameStrategy = (a: Strategy, b: Strategy) =>
  a.retry === b.retry &&
  a.breaker === b.breaker &&
  a.failover === b.failover &&
  a.smallModel === b.smallModel &&
  a.priority === b.priority;
