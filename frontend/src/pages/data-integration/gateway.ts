/* The AI gateway simulation: three invented apps share model capacity through one gateway, minute by minute. The
   gateway serves cache hits, enforces each app's tokens-per-minute limit, sends the rest to provisioned capacity
   first and spills over to pay-as-you-go, and a circuit breaker decides what happens when the provisioned backend
   fails. Prices are illustrative, not any provider's list price. */

export interface Consumer {
  id: string;
  name: string;
  /** Requests a minute at a traffic multiplier of 1. */
  rpm: number;
  /** Prompt plus reply tokens per request. */
  tokens: number;
  /** Share of requests a semantic cache can answer: repeated questions cache well, unique documents do not. */
  cacheable: number;
  /** Minutes (0-based, end exclusive) in which this app sends a batch at four times its usual rate. */
  burst?: [number, number];
}

export const CONSUMERS: Consumer[] = [
  { id: 'help', name: 'Help desk assistant', rpm: 40, tokens: 1500, cacheable: 0.3 },
  { id: 'contracts', name: 'Contract summariser', rpm: 6, tokens: 12000, cacheable: 0, burst: [5, 9] },
  { id: 'email', name: 'Email drafting', rpm: 20, tokens: 2500, cacheable: 0.05 },
];

export const MINUTES = 20;
/** The provisioned backend is down in these minutes when the outage is switched on. */
export const OUTAGE: [number, number] = [12, 15];
/** Pay-as-you-go, per 1,000 tokens. */
export const PAYG_PER_K = 0.003;
/** Provisioned capacity, per 1,000 tokens a minute of capacity, per minute: paid whether used or not. */
export const PTU_PER_K_MINUTE = 0.0015;
/** Share of the first outage minute's provisioned traffic that fails before the breaker trips. */
export const TRIP_LOSS = 0.2;

export interface GatewayConfig {
  /** Multiplies every app's request rate. */
  traffic: number;
  /** Each app's tokens-per-minute limit at the gateway, in thousands. */
  limitK: number;
  /** Provisioned capacity in thousands of tokens a minute. */
  ptuK: number;
  spillover: boolean;
  cache: boolean;
  breaker: boolean;
  outage: boolean;
}

export const DEFAULT_GATEWAY: GatewayConfig = {
  traffic: 1,
  limitK: 150,
  ptuK: 150,
  spillover: true,
  cache: true,
  breaker: true,
  outage: false,
};

/** Thousands of tokens for one app or one minute, by where they went. */
export interface Split {
  demand: number;
  cache: number;
  limited: number;
  ptu: number;
  payg: number;
  backend429: number;
  failed: number;
}

export interface ConsumerTotal extends Split {
  id: string;
  name: string;
  cost: number;
}

export interface GatewayResult {
  minutes: Split[];
  consumers: ConsumerTotal[];
  ptuCost: number;
  idleCost: number;
  paygCost: number;
}

const empty = (): Split => ({ demand: 0, cache: 0, limited: 0, ptu: 0, payg: 0, backend429: 0, failed: 0 });

/** A small seeded generator, so the same settings always give the same run. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs twenty minutes of traffic through the gateway. */
export function simulateGateway(cfg: GatewayConfig, consumers: Consumer[] = CONSUMERS): GatewayResult {
  const rand = mulberry32(7);
  const minutes: Split[] = [];
  const totals = consumers.map(() => empty());
  // Provisioned tokens each app used, to share the provisioned bill by use.
  const ptuUsed = consumers.map(() => 0);
  let ptuTotal = 0;
  let tripped = false;

  for (let m = 0; m < MINUTES; m++) {
    const row = empty();
    const down = cfg.outage && m >= OUTAGE[0] && m < OUTAGE[1];
    if (!down) tripped = false;
    // The breaker trips during the first failing minute; later minutes skip the failed backend at once.
    const lossShare = down ? (cfg.breaker ? (tripped ? 0 : TRIP_LOSS) : 1) : 0;
    const routedAway = down && cfg.breaker;
    if (down && cfg.breaker) tripped = true;

    // Step 1: each app's demand, cache hits and the gateway's token limit.
    const admitted = consumers.map((c, i) => {
      const burst = c.burst && m >= c.burst[0] && m < c.burst[1] ? 4 : 1;
      const noise = 0.85 + rand() * 0.3;
      const demand = (c.rpm * cfg.traffic * burst * noise * c.tokens) / 1000;
      const cache = cfg.cache ? demand * c.cacheable : 0;
      const wanted = demand - cache;
      const ok = Math.min(wanted, cfg.limitK);
      const t = totals[i];
      t.demand += demand;
      t.cache += cache;
      t.limited += wanted - ok;
      row.demand += demand;
      row.cache += cache;
      row.limited += wanted - ok;
      return ok;
    });

    // Step 2: the backend pool. Provisioned first, shared in proportion when over-subscribed.
    const sum = admitted.reduce((a, b) => a + b, 0);
    const ptuShare = sum > 0 ? Math.min(1, cfg.ptuK / sum) : 0;
    admitted.forEach((ok, i) => {
      const t = totals[i];
      let toPtu = ok * ptuShare;
      let over = ok - toPtu;
      if (down) {
        // Traffic meant for the failed backend: some fails before the breaker trips, the rest moves on.
        const failed = toPtu * lossShare;
        t.failed += failed;
        row.failed += failed;
        over += routedAway ? toPtu - failed : 0;
        toPtu = 0;
      }
      t.ptu += toPtu;
      row.ptu += toPtu;
      ptuUsed[i] += toPtu;
      ptuTotal += toPtu;
      if (cfg.spillover) {
        t.payg += over;
        row.payg += over;
      } else {
        t.backend429 += over;
        row.backend429 += over;
      }
    });
    minutes.push(row);
  }

  const ptuCost = cfg.ptuK * PTU_PER_K_MINUTE * MINUTES;
  const usedShare = ptuTotal / (cfg.ptuK * MINUTES || 1);
  const idleCost = ptuCost * Math.max(0, 1 - usedShare);
  const consumerTotals = consumers.map((c, i) => {
    const t = totals[i];
    // Chargeback: each app pays for the provisioned capacity it used, plus its own pay-as-you-go tokens.
    const ptuPart = ptuTotal > 0 ? ((ptuCost - idleCost) * ptuUsed[i]) / ptuTotal : 0;
    return { ...t, id: c.id, name: c.name, cost: ptuPart + t.payg * PAYG_PER_K };
  });
  const paygCost = consumerTotals.reduce((a, t) => a + t.payg * PAYG_PER_K, 0);
  return { minutes, consumers: consumerTotals, ptuCost, idleCost, paygCost };
}
