/* The statistics behind the benchmarks lab: pass@k, intervals and tests, Elo and Bradley–Terry, n-gram overlap. */

/** pass@k, unbiased (Chen et al. 2021): 1 − C(n−c, k) / C(n, k), in the paper's numerically stable product form. */
export function passAtK(n: number, c: number, k: number): number {
  if (n - c < k) return 1;
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) prod *= 1 - k / i;
  return 1 - prod;
}

/** The naive estimate: plug the observed success rate into 1 − (1 − p)^k. Biased low, because the curve is concave. */
export const naivePassAtK = (n: number, c: number, k: number) => 1 - (1 - c / n) ** k;

/** Wilson score interval for a proportion: better than p ± 1.96·se near 0 or 1, and for small N. */
export function wilson(p: number, n: number, z = 1.96): [number, number] {
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Standard normal cumulative distribution (Abramowitz–Stegun 7.1.26 for erf). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Elo, one vote at a time: the order of the votes changes the result. */
export function eloOnline(n: number, votes: [number, number][], k: number, start = 1000): number[] {
  const r = new Array(n).fill(start);
  for (const [w, l] of votes) {
    const expected = 1 / (1 + 10 ** ((r[l] - r[w]) / 400));
    r[w] += k * (1 - expected);
    r[l] -= k * (1 - expected);
  }
  return r;
}

/** Bradley–Terry fitted by the MM algorithm (Hunter 2004), on the Elo scale with mean `centre`. Depends only on the win counts. */
export function bradleyTerry(n: number, votes: [number, number][], centre = 1000, iterations = 200): number[] {
  const wins = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const [w, l] of votes) wins[w][l]++;
  const p = new Array(n).fill(1);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let w = 0;
      let d = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        w += wins[i][j];
        const games = wins[i][j] + wins[j][i];
        if (games) d += games / (p[i] + p[j]);
      }
      p[i] = d > 0 ? Math.max(w, 0.1) / d : p[i]; // a tiny floor keeps a winless model finite
    }
    const g = Math.exp(p.reduce((s, v) => s + Math.log(v), 0) / n);
    for (let i = 0; i < n; i++) p[i] /= g;
  }
  const r = p.map((v) => 400 * Math.log10(v));
  const m = r.reduce((s, v) => s + v, 0) / n;
  return r.map((v) => v - m + centre);
}

/** Share of a text's word n-grams that also appear in a reference text. */
export function ngramOverlap(reference: string, text: string, n: number): number {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const grams = (w: string[]) => Array.from({ length: Math.max(0, w.length - n + 1) }, (_, i) => w.slice(i, i + n).join(' '));
  const ref = new Set(grams(words(reference)));
  const mine = grams(words(text));
  if (!mine.length) return 0;
  return mine.filter((g) => ref.has(g)).length / mine.length;
}
