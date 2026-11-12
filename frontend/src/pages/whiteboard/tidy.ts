/* Shape tidying: when a stroke ends, code decides whether it was meant as a straight line, a circle, an ellipse, a
   triangle, a rectangle or another polygon, and redraws it exactly. Handwriting and curves are left as drawn, only
   smoothed. This runs in the page, on every stroke, with no model call: it is geometry, so code does it. */

export type Pt = [number, number];

export interface Tidied {
  points: Pt[];
  /** What the stroke was taken for, or null when it was kept as drawn. */
  shape: string | null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function length(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

function bounds(pts: Pt[]) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, d: Math.hypot(x1 - x0, y1 - y0) };
}

/** Distance from p to the line through a and b. */
function offLine(p: Pt, a: Pt, b: Pt): number {
  const l = dist(a, b);
  if (l === 0) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l;
}

/** Douglas-Peucker: the few points that keep the path within eps of where it went. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = offLine(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps) return [pts[0], pts[pts.length - 1]];
  const left = simplify(pts.slice(0, at + 1), eps);
  return left.slice(0, -1).concat(simplify(pts.slice(at), eps));
}

/** The corners of a closed loop: split at the point farthest from the start, simplify each half. */
function corners(pts: Pt[], eps: number): Pt[] {
  let far = 0;
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], pts[0]) > dist(pts[far], pts[0])) far = i;
  const a = simplify(pts.slice(0, far + 1), eps);
  const b = simplify(pts.slice(far).concat([pts[0]]), eps);
  let ring = a.slice(0, -1).concat(b.slice(0, -1));
  // drop corners on a straight run (a start point that fell mid-edge)
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i + ring.length - 1) % ring.length];
      const next = ring[(i + 1) % ring.length];
      if (offLine(ring[i], prev, next) < eps * 1.2) {
        ring = ring.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return ring;
}

/** Mean distance from the stroke to the closed polygon through ring: small when the stroke ran along straight edges. */
function offPolygon(pts: Pt[], ring: Pt[]): number {
  const seg = (p: Pt, a: Pt, b: Pt) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const total = pts.reduce((s, p) => s + Math.min(...ring.map((a, i) => seg(p, a, ring[(i + 1) % ring.length]))), 0);
  return total / pts.length;
}

/** The inside angle at b, in degrees. */
function angle(a: Pt, b: Pt, c: Pt): number {
  const v = [a[0] - b[0], a[1] - b[1]];
  const w = [c[0] - b[0], c[1] - b[1]];
  const cos = (v[0] * w[0] + v[1] * w[1]) / (Math.hypot(v[0], v[1]) * Math.hypot(w[0], w[1]) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

/** Chaikin smoothing, for strokes kept as drawn: removes the jitter of a mouse without changing the shape. */
function smooth(pts: Pt[], rounds = 2): Pt[] {
  let p = pts;
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const q: Pt[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [a, b] = [p[i], p[i + 1]];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** A straight line, snapped to horizontal or vertical when it is within 8 degrees of either. */
function line(a: Pt, b: Pt): Pt[] {
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const flat = Math.abs(((deg % 180) + 180) % 180);
  if (flat < 8 || flat > 172) return [a, [b[0], a[1]]];
  if (Math.abs(flat - 90) < 8) return [a, [a[0], b[1]]];
  return [a, b];
}

/** A rectangle through four rough corners: squared up along the first edge, a square when the sides nearly match. */
function rectangle(q: Pt[]): Pt[] {
  let theta = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]);
  const deg = ((((theta * 180) / Math.PI) % 90) + 90) % 90;
  if (deg < 8 || deg > 82) theta = 0; // nearly level: make it level
  const [c, s] = [Math.cos(theta), Math.sin(theta)];
  const u = q.map((p) => p[0] * c + p[1] * s);
  const v = q.map((p) => -p[0] * s + p[1] * c);
  let [u0, u1, v0, v1] = [Math.min(...u), Math.max(...u), Math.min(...v), Math.max(...v)];
  if (Math.abs(u1 - u0 - (v1 - v0)) < 0.1 * Math.max(u1 - u0, v1 - v0)) {
    const side = (u1 - u0 + v1 - v0) / 2;
    const [mu, mv] = [(u0 + u1) / 2, (v0 + v1) / 2];
    [u0, u1, v0, v1] = [mu - side / 2, mu + side / 2, mv - side / 2, mv + side / 2];
  }
  const back = (uu: number, vv: number): Pt => [uu * c - vv * s, uu * s + vv * c];
  return [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1), back(u0, v0)];
}

/** Takes a finished stroke and returns it tidied, or as drawn (smoothed) when it is not a clear shape. */
export function tidy(raw: Pt[]): Tidied {
  const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 0.5);
  if (pts.length < 4) return { points: raw, shape: null };
  const box = bounds(pts);
  const path = length(pts);
  if (box.d < 40) return { points: raw, shape: null }; // handwriting: letters, digits, signs

  const start = pts[0];
  const end = pts[pts.length - 1];
  const closed = dist(start, end) < Math.max(25, 0.22 * box.d) && path > 1.6 * box.d;

  if (!closed) {
    const worst = Math.max(...pts.map((p) => offLine(p, start, end)));
    if (worst < 0.06 * dist(start, end) + 2) return { points: line(start, end), shape: 'line' };
    return { points: smooth(pts), shape: null }; // a curve, such as a hand-drawn graph: keep it, smoothed
  }

  // Closed: a circle or ellipse when every point sits close to the ellipse that fills the box.
  const [cx, cy, rx, ry] = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, box.w / 2, box.h / 2];
  const misfit =
    pts.reduce((s, p) => s + Math.abs(Math.hypot((p[0] - cx) / (rx || 1), (p[1] - cy) / (ry || 1)) - 1), 0) /
    pts.length;
  const ring = corners(pts, 0.07 * box.d);
  const off = offPolygon(pts, ring) / box.d; // how far the stroke strays from straight edges between the corners

  if (ring.length === 3 && off < 0.025) return { points: [...ring, ring[0]], shape: 'triangle' };
  if (ring.length === 4 && off < 0.025 && misfit > 0.07) {
    const right = ring.every((p, i) => Math.abs(angle(ring[(i + 3) % 4], p, ring[(i + 1) % 4]) - 90) < 18);
    if (right) {
      const r = rectangle(ring);
      const square = Math.abs(dist(r[0], r[1]) - dist(r[1], r[2])) < 0.5;
      return { points: r, shape: square ? 'square' : 'rectangle' };
    }
    return { points: [...ring, ring[0]], shape: 'quadrilateral' };
  }
  if (ring.length >= 5 && ring.length <= 6 && off < 0.012 && misfit > 0.03) {
    return { points: [...ring, ring[0]], shape: `${ring.length}-sided polygon` };
  }
  if (misfit < 0.12) {
    if (Math.min(rx, ry) / Math.max(rx, ry) > 0.85) {
      const r = (rx + ry) / 2;
      return { points: ellipse(cx, cy, r, r), shape: 'circle' };
    }
    return { points: ellipse(cx, cy, rx, ry), shape: 'ellipse' };
  }
  return { points: smooth([...pts, pts[0]]), shape: null };
}
