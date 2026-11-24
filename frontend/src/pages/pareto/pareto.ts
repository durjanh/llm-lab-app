/* Pareto frontiers over quality, cost and time: which models no other model beats on all three at once. */

export interface ModelPoint {
  name: string;
  provider: string;
  /** Weights you can download and run yourself. */
  open: boolean;
  /** A quality score where higher is better, such as an index of benchmark tasks. */
  quality: number;
  /** US dollars to complete one task of the benchmark, thinking tokens included. */
  cost: number;
  /** Minutes to complete one task, from request to last token. */
  minutes: number;
}

/**
 * True when `a` is at least as good as `b` on every measure and strictly better on one: higher quality, lower cost,
 * less time. A model that something dominates is never the right choice on these three measures alone.
 */
export function dominates(a: ModelPoint, b: ModelPoint): boolean {
  const noWorse = a.quality >= b.quality && a.cost <= b.cost && a.minutes <= b.minutes;
  const better = a.quality > b.quality || a.cost < b.cost || a.minutes < b.minutes;
  return noWorse && better;
}

/** The models no other model dominates, best quality first. O(n²), which is fine for a few thousand points. */
export function frontier(points: ModelPoint[]): ModelPoint[] {
  return points
    .filter((p) => !points.some((q) => q !== p && dominates(q, p)))
    .sort((a, b) => b.quality - a.quality || a.cost - b.cost || a.minutes - b.minutes);
}

/** The frontier on quality and one other measure only, ignoring the third: what a flat chart shows. */
export function frontier2d(points: ModelPoint[], axis: 'cost' | 'minutes'): ModelPoint[] {
  const flat = points.map((p) => ({ p, q: { ...p, [axis === 'cost' ? 'minutes' : 'cost']: 0 } as ModelPoint }));
  const kept = new Set(frontier(flat.map((f) => f.q)));
  return flat
    .filter((f) => kept.has(f.q))
    .map((f) => f.p)
    .sort((a, b) => a[axis] - b[axis]);
}

export interface Limits {
  maxCost: number;
  maxMinutes: number;
  openOnly: boolean;
}

/** The best-quality model within a budget and a deadline; on a tie, the cheaper then the faster. Null if none fits. */
export function bestWithin(points: ModelPoint[], limits: Limits): ModelPoint | null {
  const fits = points.filter(
    (p) => p.cost <= limits.maxCost && p.minutes <= limits.maxMinutes && (!limits.openOnly || p.open),
  );
  return frontier(fits)[0] ?? null;
}

/** Splits one CSV line, honouring double quotes so a name may contain a comma. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export const MAX_ROWS = 2000;

export interface Parsed {
  models: ModelPoint[];
  errors: string[];
}

const TRUE = new Set(['1', 'true', 'yes', 'y', 'open']);

/**
 * Reads pasted CSV with a header row. Needs name, quality, cost and minutes; provider and open are optional. Rows
 * with a missing name, a number that is not finite, or a cost or time that is not above zero are skipped and
 * reported, so one bad row does not lose the rest.
 */
export function parseCsv(text: string): Parsed {
  // Spreadsheet exports often begin with a byte-order mark, which would hide the first column's name.
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const errors: string[] = [];
  if (!lines.length) return { models: [], errors: ['Nothing to read: paste a header row and at least one model.'] };
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const missing = ['name', 'quality', 'cost', 'minutes'].filter((n) => col(n) < 0);
  if (missing.length) return { models: [], errors: [`The header row needs these columns: ${missing.join(', ')}.`] };
  if (lines.length - 1 > MAX_ROWS) errors.push(`Only the first ${MAX_ROWS} rows were read.`);
  const models: ModelPoint[] = [];
  lines.slice(1, MAX_ROWS + 1).forEach((line, i) => {
    const f = splitCsvLine(line);
    const row = i + 2;
    const name = f[col('name')] ?? '';
    const num = (n: string) => {
      const s = f[col(n)];
      return s === undefined || s === '' ? NaN : Number(s);
    };
    const quality = num('quality');
    const cost = num('cost');
    const minutes = num('minutes');
    if (!name) return void errors.push(`Row ${row}: no name.`);
    if (![quality, cost, minutes].every(Number.isFinite))
      return void errors.push(`Row ${row} (${name}): quality, cost and minutes must be numbers.`);
    if (cost <= 0 || minutes <= 0)
      return void errors.push(`Row ${row} (${name}): cost and minutes must be above zero for a log scale.`);
    const provider = col('provider') >= 0 && f[col('provider')] ? f[col('provider')] : 'Unknown';
    const open = col('open') >= 0 ? TRUE.has((f[col('open')] ?? '').toLowerCase()) : false;
    models.push({ name, provider, open, quality, cost, minutes });
  });
  if (!models.length && !errors.length) errors.push('No model rows found under the header.');
  return { models, errors };
}

/** Writes models back out as CSV in the format `parseCsv` reads. */
export function toCsv(points: ModelPoint[]): string {
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['name,provider,open,quality,cost,minutes']
    .concat(points.map((p) => [q(p.name), q(p.provider), p.open, p.quality, p.cost, p.minutes].join(',')))
    .join('\n');
}

/** The quality axis: from a round ten at or below the lowest score to one at or above the highest, never empty. */
export function qualityRange(qualities: number[]): [number, number] {
  const lo = Math.min(0, Math.floor(Math.min(...qualities) / 10) * 10);
  const hi = Math.ceil(Math.max(...qualities) / 10) * 10;
  return [lo, hi > lo ? hi : lo + 10];
}

/** Maps a value onto [-1, 1] on a log scale between lo and hi; equal bounds give the middle. */
export function logUnit(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 2 - 1;
}

export interface View {
  /** Turn about the vertical axis, in degrees. */
  yaw: number;
  /** Tilt towards the viewer, in degrees. */
  pitch: number;
}

/**
 * Projects a point in the unit cube onto the screen with an orthographic camera. x is cheapness, y is speed and z
 * is quality, each in [-1, 1]; the result is a screen offset (right and up) and a depth for drawing order.
 */
export function project(x: number, y: number, z: number, view: View): { sx: number; sy: number; depth: number } {
  const a = (view.yaw * Math.PI) / 180;
  const b = (view.pitch * Math.PI) / 180;
  const x1 = x * Math.cos(a) - y * Math.sin(a);
  const y1 = x * Math.sin(a) + y * Math.cos(a);
  return { sx: x1, sy: z * Math.cos(b) + y1 * Math.sin(b), depth: y1 * Math.cos(b) - z * Math.sin(b) };
}
