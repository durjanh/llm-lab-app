/* The whiteboard's solids as vertices and edges, and the cross-section of a solid by a plane: the polygon, its interior
   angles, area and perimeter. Computed here, never by the model. Curved solids are approximated by many-sided ones. */

export type Vec = [number, number, number];
export type Shape =
  'cube' | 'cuboid' | 'square_pyramid' | 'tetrahedron' | 'triangular_prism' | 'cylinder' | 'cone' | 'sphere';

export interface Solid {
  shape: Shape;
  width: number;
  depth: number;
  height: number;
}

export interface Poly {
  vertices: Vec[];
  edges: [number, number][];
  curved: boolean;
}

const SIDES = 48; // a cylinder or cone, approximated

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec): Vec => scale(a, 1 / (norm(a) || 1));

function ring(n: number, rx: number, rz: number, y: number, phase = 0): Vec[] {
  return Array.from({ length: n }, (_, i) => {
    const t = phase + (2 * Math.PI * i) / n;
    return [rx * Math.cos(t), y, rz * Math.sin(t)] as Vec;
  });
}

function prism(base: Vec[], h: number): Poly {
  const n = base.length;
  const bottom = base.map(([x, , z]) => [x, -h / 2, z] as Vec);
  const top = base.map(([x, , z]) => [x, h / 2, z] as Vec);
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    edges.push([i, (i + 1) % n], [n + i, n + ((i + 1) % n)], [i, n + i]);
  }
  return { vertices: [...bottom, ...top], edges, curved: false };
}

function pyramid(base: Vec[], h: number): Poly {
  const n = base.length;
  const bottom = base.map(([x, , z]) => [x, -h / 2, z] as Vec);
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n], [i, n]);
  return { vertices: [...bottom, [0, h / 2, 0]], edges, curved: false };
}

/** The solid as a polyhedron: exact for flat-faced shapes, many-sided for a cylinder or cone. A sphere has none. */
export function polyhedron(s: Solid): Poly | null {
  const w = s.width / 2;
  const d = s.depth / 2;
  switch (s.shape) {
    case 'cube':
    case 'cuboid':
      return prism(
        [
          [-w, 0, -d],
          [w, 0, -d],
          [w, 0, d],
          [-w, 0, d],
        ],
        s.height,
      );
    case 'square_pyramid':
      return pyramid(
        [
          [-w, 0, -d],
          [w, 0, -d],
          [w, 0, d],
          [-w, 0, d],
        ],
        s.height,
      );
    case 'tetrahedron':
      return pyramid(ring(3, w, d, 0, Math.PI / 2), s.height);
    case 'triangular_prism': {
      // A prism lying along z: its triangular faces are at the front and back.
      const tri: [number, number][] = [
        [-w, -s.height / 2],
        [w, -s.height / 2],
        [0, s.height / 2],
      ];
      const front = tri.map(([x, y]) => [x, y, -d] as Vec);
      const back = tri.map(([x, y]) => [x, y, d] as Vec);
      return {
        vertices: [...front, ...back],
        edges: [
          [0, 1],
          [1, 2],
          [2, 0],
          [3, 4],
          [4, 5],
          [5, 3],
          [0, 3],
          [1, 4],
          [2, 5],
        ],
        curved: false,
      };
    }
    case 'cylinder':
      return { ...prism(ring(SIDES, w, d, 0), s.height), curved: true };
    case 'cone':
      return { ...pyramid(ring(SIDES, w, d, 0), s.height), curved: true };
    default:
      return null;
  }
}

export interface Section {
  points: Vec[]; // in order around the polygon
  angles: number[]; // interior angle at each point, in degrees
  area: number;
  perimeter: number;
  curved: boolean;
}

/** How far the plane can move from the centre and still cut the solid. */
export function reach(s: Solid, normal: Vec): number {
  const n = unit(normal);
  if (s.shape === 'sphere') return Math.min(s.width, s.depth, s.height) / 2;
  const p = polyhedron(s);
  return p ? Math.max(...p.vertices.map((v) => Math.abs(dot(n, v)))) : 1;
}

/** The plane n·p = offset (n a unit normal) cut through the solid: an ordered polygon, or null if it misses. */
export function section(s: Solid, normal: Vec, offset: number): Section | null {
  const n = unit(normal);
  if (s.shape === 'sphere') {
    const r = Math.min(s.width, s.depth, s.height) / 2;
    if (Math.abs(offset) >= r) return null;
    const rc = Math.sqrt(r * r - offset * offset);
    const [u, v] = basis(n);
    const points = Array.from({ length: SIDES }, (_, i) => {
      const t = (2 * Math.PI * i) / SIDES;
      return add(scale(n, offset), add(scale(u, rc * Math.cos(t)), scale(v, rc * Math.sin(t))));
    });
    return { points, angles: [], area: Math.PI * rc * rc, perimeter: 2 * Math.PI * rc, curved: true };
  }
  const p = polyhedron(s);
  if (!p) return null;
  const eps = 1e-9;
  const found: Vec[] = [];
  const push = (q: Vec) => {
    if (!found.some((f) => norm(sub(f, q)) < 1e-6)) found.push(q);
  };
  for (const [i, j] of p.edges) {
    const a = p.vertices[i];
    const b = p.vertices[j];
    const sa = dot(n, a) - offset;
    const sb = dot(n, b) - offset;
    if (Math.abs(sa) < eps) push(a);
    if (Math.abs(sb) < eps) push(b);
    if (sa * sb < -eps * eps) push(add(a, scale(sub(b, a), sa / (sa - sb))));
  }
  if (found.length < 3) return null;
  const centre = scale(
    found.reduce((acc, q) => add(acc, q), [0, 0, 0] as Vec),
    1 / found.length,
  );
  const [u, v] = basis(n);
  const flat = (q: Vec): [number, number] => [dot(sub(q, centre), u), dot(sub(q, centre), v)];
  const points = found.slice().sort((a, b) => {
    const [ax, ay] = flat(a);
    const [bx, by] = flat(b);
    return Math.atan2(ay, ax) - Math.atan2(by, bx);
  });
  const k = points.length;
  let area = 0;
  let perimeter = 0;
  const angles: number[] = [];
  for (let i = 0; i < k; i++) {
    const prev = points[(i - 1 + k) % k];
    const here = points[i];
    const next = points[(i + 1) % k];
    const [x1, y1] = flat(here);
    const [x2, y2] = flat(next);
    area += x1 * y2 - x2 * y1;
    perimeter += norm(sub(next, here));
    const a = unit(sub(prev, here));
    const b = unit(sub(next, here));
    angles.push((Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI);
  }
  return { points, angles, area: Math.abs(area) / 2, perimeter, curved: p.curved };
}

/** Two unit vectors at right angles to n and to each other: axes for drawing in the plane. */
export function basis(n: Vec): [Vec, Vec] {
  const helper: Vec = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(n, helper));
  return [u, cross(n, u)];
}

/** A name for the section, from its number of sides. */
export function sectionName(sec: Section): string {
  if (sec.curved) return sec.angles.length === 0 ? 'a circle' : 'a curve (a circle or an ellipse)';
  const n = sec.points.length;
  const sides = sec.points.map((p, i) => norm(sub(sec.points[(i + 1) % n], p)));
  const same = (xs: number[], tol: number) => xs.every((x) => Math.abs(x - xs[0]) < tol);
  const equalSides = same(sides, 1e-3 * Math.max(...sides));
  const equalAngles = same(sec.angles, 0.5);
  if (n === 3) return equalSides ? 'an equilateral triangle' : 'a triangle';
  if (n === 4) {
    if (equalAngles) return equalSides ? 'a square' : 'a rectangle';
    return equalSides ? 'a rhombus' : 'a quadrilateral';
  }
  const names: Record<number, string> = { 5: 'pentagon', 6: 'hexagon', 7: 'heptagon', 8: 'octagon' };
  const name = names[n] ?? `${n}-sided polygon`;
  return equalSides && equalAngles ? `a regular ${name}` : `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
}
