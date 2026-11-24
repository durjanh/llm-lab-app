/* An invented field of models for the Pareto page. The names, providers and numbers are made up on purpose: real
   scores change every week and belong to whoever measured them, so the page reads real data only when pasted in. */
import type { ModelPoint } from './pareto';

interface Family {
  name: string;
  provider: string;
  open: boolean;
  /** Quality, cost per task (USD) and minutes per task at the lowest effort. */
  q: number;
  c: number;
  t: number;
  efforts: Effort[];
}

type Effort = 'Low' | 'Medium' | 'High' | 'Max';

/* What raising the effort does: more thinking buys quality with diminishing returns, while cost and time grow fast. */
const STEP: Record<Effort, { q: number; c: number; t: number }> = {
  Low: { q: 0, c: 1, t: 1 },
  Medium: { q: 5, c: 2.2, t: 1.8 },
  High: { q: 9, c: 4.5, t: 3.2 },
  Max: { q: 11, c: 9, t: 6 },
};

const ALL: Effort[] = ['Low', 'Medium', 'High', 'Max'];

const FAMILIES: Family[] = [
  { name: 'Northwind Summit', provider: 'Northwind Labs', open: false, q: 54, c: 1.4, t: 3, efforts: ALL },
  { name: 'Northwind Ridge', provider: 'Northwind Labs', open: false, q: 41, c: 0.22, t: 1.1, efforts: ALL },
  {
    name: 'Northwind Pebble',
    provider: 'Northwind Labs',
    open: false,
    q: 24,
    c: 0.03,
    t: 0.55,
    efforts: ['Low', 'High'],
  },
  { name: 'Aster Nova', provider: 'Aster', open: false, q: 52, c: 2.6, t: 4.2, efforts: ALL },
  // Quick but dear for its quality: on the three-measure frontier for its speed alone.
  { name: 'Aster Flare', provider: 'Aster', open: false, q: 37, c: 0.6, t: 0.5, efforts: ALL },
  { name: 'Aster Spark', provider: 'Aster', open: false, q: 19, c: 0.012, t: 0.45, efforts: ['Low', 'High'] },
  {
    name: 'Kestrel Talon',
    provider: 'Kestrel AI',
    open: false,
    q: 48,
    c: 1.8,
    t: 0.9,
    efforts: ['Medium', 'High', 'Max'],
  },
  { name: 'Kestrel Dart', provider: 'Kestrel AI', open: false, q: 34, c: 0.4, t: 0.25, efforts: ['Low', 'High'] },
  { name: 'Kestrel Wing', provider: 'Kestrel AI', open: false, q: 31, c: 0.07, t: 0.8, efforts: ['Low', 'High'] },
  {
    name: 'Openfield 3 Large',
    provider: 'Openfield',
    open: true,
    q: 43,
    c: 0.28,
    t: 2.9,
    efforts: ['Low', 'High', 'Max'],
  },
  { name: 'Openfield 3 Small', provider: 'Openfield', open: true, q: 23, c: 0.014, t: 0.7, efforts: ['Low', 'High'] },
  { name: 'Tidewater Deep', provider: 'Tidewater', open: true, q: 39, c: 0.18, t: 4.8, efforts: ['Medium', 'High'] },
  { name: 'Tidewater Mini', provider: 'Tidewater', open: true, q: 11, c: 0.005, t: 0.5, efforts: ['Low'] },
  { name: 'Tidewater Coder', provider: 'Tidewater', open: true, q: 30, c: 0.09, t: 2.2, efforts: ['Low', 'High'] },
];

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** Each family at each of its effort settings, as separate points: a setting is a different trade-off. */
export const SAMPLE: ModelPoint[] = FAMILIES.flatMap((f) =>
  f.efforts.map((e) => ({
    name: `${f.name} (${e})`,
    provider: f.provider,
    open: f.open,
    quality: round(Math.min(78, f.q + STEP[e].q * (f.q / 50)), 1),
    cost: round(f.c * STEP[e].c, 4),
    minutes: round(f.t * STEP[e].t, 2),
  })),
);
