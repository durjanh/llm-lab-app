/* Chapter 10: convolution in 1D and 2D, downsampling and upsampling, and two small convolutional networks trained live. */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { ChapterDef } from './chapters';
import { clamp, fmt, gauss, rng, useAnimation } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { Plot, type Frame } from './Plot';

/* ---------- shared drawing ---------- */

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="dl-legend">
      {items.map(([colour, label]) => (
        <span key={label}>
          <i style={{ background: `var(--${colour})` }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function pixelColour(v: number, max: number, signed: boolean): string {
  const t = max > 0 ? Math.min(1, Math.abs(v) / max) : 0;
  if (!signed) return `color-mix(in srgb, var(--ink) ${Math.round(Math.max(0, v / max) * 100)}%, var(--surface))`;
  return `color-mix(in srgb, ${v < 0 ? 'var(--s2)' : 'var(--s1)'} ${Math.round(t * 85)}%, var(--surface))`;
}

interface PixelsProps {
  img: ArrayLike<number>;
  h: number;
  w: number;
  cell?: number;
  /** Blue for positive and orange for negative values; otherwise grey levels from 0 up. */
  signed?: boolean;
  max?: number;
  /** A rectangle to outline: first row, first column, last row, last column. */
  box?: [number, number, number, number] | null;
  pick?: [number, number] | null;
  /** Prints each value with this many decimals. */
  digits?: number;
  onCell?: (r: number, c: number, phase: 'start' | 'move') => void;
  label: string;
}

/** A small image or matrix as a grid of coloured squares. */
function Pixels({ img, h, w, cell = 14, signed = false, max, box, pick, digits, onCell, label }: PixelsProps) {
  const m = max ?? Math.max(1e-9, ...Array.from(img, (v) => Math.abs(v)));
  const pressed = useRef(false);
  const at = (e: ReactPointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      clamp(Math.floor(((e.clientY - r.top) / r.height) * h), 0, h - 1),
      clamp(Math.floor(((e.clientX - r.left) / r.width) * w), 0, w - 1),
    ];
  };
  const rects: ReactNode[] = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = img[r * w + c];
      rects.push(
        <rect
          key={`${r}-${c}`}
          x={c * cell}
          y={r * cell}
          width={cell}
          height={cell}
          style={{ fill: pixelColour(v, m, signed) }}
        />,
      );
      if (digits !== undefined) {
        rects.push(
          <text
            key={`t${r}-${c}`}
            x={c * cell + cell / 2}
            y={r * cell + cell / 2 + 3.5}
            textAnchor="middle"
            style={{
              fill: 'var(--ink)',
              fontSize: Math.min(10, cell / 3),
              stroke: 'var(--surface)',
              strokeWidth: 2,
              paintOrder: 'stroke',
            }}
          >
            {Math.abs(v) < 1e-9 ? '0' : v.toFixed(digits)}
          </text>,
        );
      }
    }
  }
  return (
    <svg
      viewBox={`-1 -1 ${w * cell + 2} ${h * cell + 2}`}
      width={w * cell + 2}
      style={{
        maxWidth: '100%',
        height: 'auto',
        display: 'block',
        touchAction: onCell ? 'none' : undefined,
        cursor: onCell ? 'pointer' : undefined,
      }}
      role="img"
      aria-label={label}
      onPointerDown={
        onCell &&
        ((e) => {
          pressed.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onCell(...at(e), 'start');
        })
      }
      onPointerMove={onCell && ((e) => pressed.current && onCell(...at(e), 'move'))}
      onPointerUp={onCell && (() => (pressed.current = false))}
    >
      {rects}
      <rect
        x={0}
        y={0}
        width={w * cell}
        height={h * cell}
        style={{ fill: 'none', stroke: 'var(--line2)', strokeWidth: 1 }}
      />
      {box && (
        <rect
          x={box[1] * cell}
          y={box[0] * cell}
          width={(box[3] - box[1] + 1) * cell}
          height={(box[2] - box[0] + 1) * cell}
          style={{ fill: 'none', stroke: 'var(--brand)', strokeWidth: 2.5 }}
        />
      )}
      {pick && (
        <rect
          x={pick[1] * cell}
          y={pick[0] * cell}
          width={cell}
          height={cell}
          style={{ fill: 'none', stroke: 'var(--bad)', strokeWidth: 2.5 }}
        />
      )}
    </svg>
  );
}

function Labelled({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/* ---------- digit-like glyphs, drawn from strokes ---------- */

type Pt = [number, number];

const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 16): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });

const PI = Math.PI;

/** Strokes for ten digit-like shapes in a unit square (x to the right, y down). */
const GLYPHS: Pt[][][] = [
  [arc(0.5, 0.5, 0.26, 0.37, 0, 2 * PI, 20)],
  [
    [
      [0.32, 0.26],
      [0.52, 0.1],
      [0.52, 0.9],
    ],
  ],
  [[...arc(0.5, 0.32, 0.26, 0.22, 1.05 * PI, 2.15 * PI, 10), [0.22, 0.9], [0.8, 0.9]]],
  [arc(0.5, 0.3, 0.25, 0.2, 1.15 * PI, 2.5 * PI, 12), arc(0.5, 0.7, 0.27, 0.2, 1.5 * PI, 2.85 * PI, 12)],
  [
    [
      [0.62, 0.9],
      [0.62, 0.1],
      [0.18, 0.66],
      [0.84, 0.66],
    ],
  ],
  [[[0.78, 0.1], [0.3, 0.1], [0.26, 0.46], ...arc(0.5, 0.66, 0.27, 0.24, 1.3 * PI, 2.85 * PI, 12)]],
  [[[0.7, 0.1], [0.42, 0.28], [0.27, 0.5], ...arc(0.5, 0.66, 0.26, 0.24, PI, 3 * PI, 16)]],
  [
    [
      [0.18, 0.12],
      [0.82, 0.12],
      [0.42, 0.9],
    ],
  ],
  [arc(0.5, 0.29, 0.21, 0.19, 0, 2 * PI), arc(0.5, 0.69, 0.25, 0.21, 0, 2 * PI)],
  [
    arc(0.5, 0.33, 0.24, 0.22, 0, 2 * PI),
    [
      [0.74, 0.33],
      [0.66, 0.9],
    ],
  ],
];

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len > 0 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len, 0, 1) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Rasterises a glyph onto a size×size grid; with `rand`, it is scaled, rotated, shifted and noisy, like a new hand. */
function drawGlyph(digit: number, size: number, rand?: () => number, noise = 0): Float64Array {
  const r = rand ?? (() => 0.5);
  const scale = rand ? 0.82 + 0.3 * r() : 1;
  const turn = rand ? (r() - 0.5) * 0.35 : 0;
  const dx = rand ? (r() - 0.5) * 0.2 : 0;
  const dy = rand ? (r() - 0.5) * 0.16 : 0;
  const thick = rand ? 0.045 + 0.04 * r() : 0.065;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const move = ([x, y]: Pt): Pt => [
    0.5 + scale * (cos * (x - 0.5) - sin * (y - 0.5)) + dx,
    0.5 + scale * (sin * (x - 0.5) + cos * (y - 0.5)) + dy,
  ];
  const strokes = GLYPHS[digit].map((s) => s.map(move));
  const out = new Float64Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const p: Pt = [(col + 0.5) / size, (row + 0.5) / size];
      let d = Infinity;
      for (const s of strokes)
        for (let i = 0; i + 1 < s.length; i++) d = Math.min(d, segmentDistance(p, s[i], s[i + 1]));
      const v = clamp((thick + 0.5 / size - d) * size, 0, 1) + (rand && noise ? gauss(r) * noise : 0);
      out[row * size + col] = clamp(v, 0, 1);
    }
  }
  return out;
}

/* ---------- a tiny network library: convolution, ReLU, max pooling, dense, softmax and Adam ---------- */

interface Layer {
  params: Float64Array[];
  grads: Float64Array[];
  forward(x: Float64Array): Float64Array;
  /** Takes ∂loss/∂output, adds to the parameter gradients and returns ∂loss/∂input. */
  backward(g: Float64Array): Float64Array;
}

const heInit = (rand: () => number, n: number, fanIn: number) =>
  Float64Array.from({ length: n }, () => gauss(rand) * Math.sqrt(2 / fanIn));

/** A convolution over a C×H×W input with zero padding. A 1D signal is the case H = 1 with a 1×K kernel. */
class Conv implements Layer {
  ci: number;
  h: number;
  w: number;
  co: number;
  kh: number;
  kw: number;
  s: number;
  ph: number;
  pw: number;
  ho: number;
  wo: number;
  W: Float64Array;
  b: Float64Array;
  gW: Float64Array;
  gb: Float64Array;
  params: Float64Array[];
  grads: Float64Array[];
  x: Float64Array = new Float64Array(0);

  constructor(
    o: { ci: number; h: number; w: number; co: number; kh: number; kw: number; stride: number; ph: number; pw: number },
    rand: () => number,
  ) {
    this.ci = o.ci;
    this.h = o.h;
    this.w = o.w;
    this.co = o.co;
    this.kh = o.kh;
    this.kw = o.kw;
    this.s = o.stride;
    this.ph = o.ph;
    this.pw = o.pw;
    this.ho = Math.floor((o.h + 2 * o.ph - o.kh) / o.stride) + 1;
    this.wo = Math.floor((o.w + 2 * o.pw - o.kw) / o.stride) + 1;
    this.W = heInit(rand, o.co * o.ci * o.kh * o.kw, o.ci * o.kh * o.kw);
    this.b = new Float64Array(o.co);
    this.gW = new Float64Array(this.W.length);
    this.gb = new Float64Array(o.co);
    this.params = [this.W, this.b];
    this.grads = [this.gW, this.gb];
  }

  forward(x: Float64Array): Float64Array {
    this.x = x;
    const { ci, h, w, co, kh, kw, s, ph, pw, ho, wo, W, b } = this;
    const out = new Float64Array(co * ho * wo);
    for (let o = 0; o < co; o++) {
      for (let y = 0; y < ho; y++) {
        for (let xx = 0; xx < wo; xx++) {
          let acc = b[o];
          for (let c = 0; c < ci; c++) {
            for (let ky = 0; ky < kh; ky++) {
              const iy = y * s + ky - ph;
              if (iy < 0 || iy >= h) continue;
              const wRow = ((o * ci + c) * kh + ky) * kw;
              const xRow = (c * h + iy) * w;
              for (let kx = 0; kx < kw; kx++) {
                const ix = xx * s + kx - pw;
                if (ix >= 0 && ix < w) acc += W[wRow + kx] * x[xRow + ix];
              }
            }
          }
          out[(o * ho + y) * wo + xx] = acc;
        }
      }
    }
    return out;
  }

  backward(g: Float64Array): Float64Array {
    const { ci, h, w, co, kh, kw, s, ph, pw, ho, wo, W, gW, gb, x } = this;
    const gx = new Float64Array(ci * h * w);
    for (let o = 0; o < co; o++) {
      for (let y = 0; y < ho; y++) {
        for (let xx = 0; xx < wo; xx++) {
          const gv = g[(o * ho + y) * wo + xx];
          if (gv === 0) continue;
          gb[o] += gv;
          for (let c = 0; c < ci; c++) {
            for (let ky = 0; ky < kh; ky++) {
              const iy = y * s + ky - ph;
              if (iy < 0 || iy >= h) continue;
              const wRow = ((o * ci + c) * kh + ky) * kw;
              const xRow = (c * h + iy) * w;
              for (let kx = 0; kx < kw; kx++) {
                const ix = xx * s + kx - pw;
                if (ix < 0 || ix >= w) continue;
                gW[wRow + kx] += gv * x[xRow + ix];
                gx[xRow + ix] += gv * W[wRow + kx];
              }
            }
          }
        }
      }
    }
    return gx;
  }
}

class Relu implements Layer {
  params: Float64Array[] = [];
  grads: Float64Array[] = [];
  y: Float64Array = new Float64Array(0);
  forward(x: Float64Array): Float64Array {
    this.y = x.map((v) => (v > 0 ? v : 0));
    return this.y;
  }
  backward(g: Float64Array): Float64Array {
    return g.map((v, i) => (this.y[i] > 0 ? v : 0));
  }
}

/** 2×2 max pooling with stride 2 on each of c channels. */
class MaxPool implements Layer {
  params: Float64Array[] = [];
  grads: Float64Array[] = [];
  c: number;
  h: number;
  w: number;
  from = new Int32Array(0);
  constructor(c: number, h: number, w: number) {
    this.c = c;
    this.h = h;
    this.w = w;
  }
  forward(x: Float64Array): Float64Array {
    const { c, h, w } = this;
    const ho = h >> 1;
    const wo = w >> 1;
    const out = new Float64Array(c * ho * wo);
    this.from = new Int32Array(out.length);
    for (let k = 0; k < c; k++) {
      for (let y = 0; y < ho; y++) {
        for (let xx = 0; xx < wo; xx++) {
          let best = -Infinity;
          let at = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const i = (k * h + 2 * y + dy) * w + 2 * xx + dx;
              if (x[i] > best) [best, at] = [x[i], i];
            }
          }
          const o = (k * ho + y) * wo + xx;
          out[o] = best;
          this.from[o] = at;
        }
      }
    }
    return out;
  }
  backward(g: Float64Array): Float64Array {
    const gx = new Float64Array(this.c * this.h * this.w);
    g.forEach((v, o) => (gx[this.from[o]] += v));
    return gx;
  }
}

class Dense implements Layer {
  nIn: number;
  nOut: number;
  W: Float64Array;
  b: Float64Array;
  gW: Float64Array;
  gb: Float64Array;
  params: Float64Array[];
  grads: Float64Array[];
  x: Float64Array = new Float64Array(0);
  constructor(nIn: number, nOut: number, rand: () => number) {
    this.nIn = nIn;
    this.nOut = nOut;
    this.W = heInit(rand, nIn * nOut, nIn);
    this.b = new Float64Array(nOut);
    this.gW = new Float64Array(this.W.length);
    this.gb = new Float64Array(nOut);
    this.params = [this.W, this.b];
    this.grads = [this.gW, this.gb];
  }
  forward(x: Float64Array): Float64Array {
    this.x = x;
    const out = new Float64Array(this.nOut);
    for (let o = 0; o < this.nOut; o++) {
      let acc = this.b[o];
      const row = o * this.nIn;
      for (let i = 0; i < this.nIn; i++) acc += this.W[row + i] * x[i];
      out[o] = acc;
    }
    return out;
  }
  backward(g: Float64Array): Float64Array {
    const gx = new Float64Array(this.nIn);
    for (let o = 0; o < this.nOut; o++) {
      const gv = g[o];
      if (gv === 0) continue;
      this.gb[o] += gv;
      const row = o * this.nIn;
      for (let i = 0; i < this.nIn; i++) {
        this.gW[row + i] += gv * this.x[i];
        gx[i] += gv * this.W[row + i];
      }
    }
    return gx;
  }
}

function softmaxArr(z: Float64Array): Float64Array {
  let m = -Infinity;
  for (const v of z) m = Math.max(m, v);
  const e = z.map((v) => Math.exp(v - m));
  let s = 0;
  for (const v of e) s += v;
  return e.map((v) => v / s);
}

/** A stack of layers trained with softmax cross-entropy and Adam. */
class Net {
  layers: Layer[];
  m: Float64Array[];
  v: Float64Array[];
  t = 0;
  acts: Float64Array[] = [];
  constructor(layers: Layer[]) {
    this.layers = layers;
    const ps = layers.flatMap((l) => l.params);
    this.m = ps.map((p) => new Float64Array(p.length));
    this.v = ps.map((p) => new Float64Array(p.length));
  }
  get count(): number {
    return this.layers.reduce((n, l) => n + l.params.reduce((a, p) => a + p.length, 0), 0);
  }
  forward(x: Float64Array): Float64Array {
    this.acts = [x];
    for (const l of this.layers) {
      x = l.forward(x);
      this.acts.push(x);
    }
    return x;
  }
  probs(x: Float64Array): Float64Array {
    return softmaxArr(this.forward(x));
  }
  /** One Adam step on the examples in idx; returns their mean loss. */
  train(xs: Float64Array[], ys: number[], idx: number[], lr: number): number {
    for (const l of this.layers) for (const g of l.grads) g.fill(0);
    let loss = 0;
    for (const i of idx) {
      const p = this.probs(xs[i]);
      loss -= Math.log(p[ys[i]] + 1e-12);
      p[ys[i]] -= 1;
      let g: Float64Array = p.map((v) => v / idx.length);
      for (let k = this.layers.length - 1; k >= 0; k--) g = this.layers[k].backward(g);
    }
    this.t++;
    const [b1, b2] = [0.9, 0.999];
    const c1 = 1 - b1 ** this.t;
    const c2 = 1 - b2 ** this.t;
    let j = 0;
    for (const l of this.layers) {
      l.params.forEach((p, pi) => {
        const g = l.grads[pi];
        const m = this.m[j];
        const v = this.v[j];
        for (let i = 0; i < p.length; i++) {
          m[i] = b1 * m[i] + (1 - b1) * g[i];
          v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
          p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8);
        }
        j++;
      });
    }
    return loss / idx.length;
  }
  accuracy(xs: Float64Array[], ys: number[], limit = Infinity): number {
    const n = Math.min(xs.length, limit);
    let right = 0;
    for (let i = 0; i < n; i++) if (argmax(this.forward(xs[i])) === ys[i]) right++;
    return right / n;
  }
}

function argmax(z: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < z.length; i++) if (z[i] > z[best]) best = i;
  return best;
}

function batch(rand: () => number, n: number, size: number): number[] {
  return Array.from({ length: size }, () => Math.floor(rand() * n));
}

interface History {
  step: number;
  values: number[];
}

function RunButtons({
  running,
  toggle,
  stepOnce,
  reset,
  done,
}: {
  running: boolean;
  toggle: () => void;
  stepOnce: () => void;
  reset: () => void;
  done: boolean;
}) {
  return (
    <div className="row">
      <button className="btn primary small" onClick={toggle} disabled={done && !running}>
        {running ? 'Pause' : 'Train'}
      </button>
      <button className="btn small" onClick={stepOnce} disabled={running || done}>
        Step
      </button>
      <button className="btn small" onClick={reset}>
        Reset
      </button>
    </div>
  );
}

/* ---------- 10.1 1D convolution ---------- */

const N1 = 20;
type SignalId = 'step' | 'spike' | 'wave' | 'noisy';
const SIGNALS: Record<SignalId, { label: string; f: (i: number) => number }> = {
  step: { label: 'Step', f: (i) => (i >= 9 ? 1 : 0) },
  spike: { label: 'Spike', f: (i) => (i === 7 ? 1 : 0) },
  wave: { label: 'Wave', f: (i) => Math.sin(i / 2) },
  noisy: { label: 'Noisy wave', f: (i) => Math.sin(i / 2) + 0.4 * gauss(rng(i * 31 + 7)) },
};

type KernelId = 'mean' | 'diff' | 'second' | 'identity' | 'smooth5';
const KERNELS_1D: Record<KernelId, { label: string; w: number[] }> = {
  mean: { label: 'Mean of 3', w: [1 / 3, 1 / 3, 1 / 3] },
  diff: { label: 'Slope', w: [-0.5, 0, 0.5] },
  second: { label: 'Curvature', w: [1, -2, 1] },
  identity: { label: 'Identity', w: [0, 1, 0] },
  smooth5: { label: 'Smooth 5', w: [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] },
};

/** Changes the kernel size, keeping the weights centred. */
function resize(w: number[], k: number): number[] {
  const out = new Array<number>(k).fill(0);
  const shift = (k - w.length) / 2;
  w.forEach((v, i) => {
    const j = i + shift;
    if (j >= 0 && j < k) out[j] = v;
  });
  return out;
}

function conv1d(x: number[], w: number[], s: number, p: number, d: number) {
  const k = w.length;
  const len = Math.floor((x.length + 2 * p - d * (k - 1) - 1) / s) + 1;
  const z: number[] = [];
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (let j = 0; j < k; j++) {
      const at = i * s + j * d - p;
      if (at >= 0 && at < x.length) acc += w[j] * x[at];
    }
    z.push(acc);
  }
  return z;
}

function Conv1D() {
  const [signal, setSignal] = useState<SignalId>('step');
  const [preset, setPreset] = useState<KernelId | 'custom'>('mean');
  const [w, setW] = useState(KERNELS_1D.mean.w);
  const [stride, setStride] = useState(1);
  const [pad, setPad] = useState(1);
  const [dil, setDil] = useState(1);
  const [shift, setShift] = useState(0);
  const [pickOut, setPickOut] = useState(4);
  const k = w.length;
  const x = Array.from({ length: N1 }, (_, i) => (i - shift >= 0 ? SIGNALS[signal].f(i - shift) : 0));
  const z = conv1d(x, w, stride, pad, dil);
  const len = z.length;
  const o = clamp(pickOut, 0, Math.max(0, len - 1));
  const taps = w.map((_, j) => o * stride + j * dil - pad);
  const centre = (i: number) => i * stride + (dil * (k - 1)) / 2 - pad;
  const xr: [number, number] = [-pad - 1, N1 + pad];
  const all = [...x, ...z, 0];
  const lo = Math.min(...all) - 0.3;
  const hi = Math.max(...all) + 0.3;
  const matrix = new Float64Array(Math.max(1, len) * N1);
  for (let i = 0; i < len; i++) {
    w.forEach((v, j) => {
      const at = i * stride + j * dil - pad;
      if (at >= 0 && at < N1) matrix[i * N1 + at] += v;
    });
  }
  const formula = `⌊(${N1} + 2·${pad} − ${dil}·(${k} − 1) − 1) / ${stride}⌋ + 1 = ${Math.max(0, len)}`;
  const terms = w.map((v, j) => `${fmt(v, 2)}·${taps[j] >= 0 && taps[j] < N1 ? `x${taps[j]}` : '0'}`);
  const stems = (f: Frame, xs: number[], ys: number[], colour: string) => {
    xs.forEach((xv, i) => f.line([xv, xv], [0, ys[i]], colour, 1.5));
    f.dots(
      xs.map((xv, i) => [xv, ys[i]] as [number, number]),
      colour,
    );
  };

  return (
    <Notebook
      id="10.1"
      title="1D convolution"
      intro={
        <>
          A convolution slides one small set of weights, the kernel ω, along the input. Each output is the weighted sum
          of a few nearby inputs: zᵢ = Σⱼ ωⱼ x at position i·S + (j − 1)·D − P. Stride S skips positions, padding P adds
          zeros at the ends, and dilation D spreads the kernel out with gaps. Like the book, this is strictly a
          cross-correlation: the kernel is not flipped.
        </>
      }
      tryThis={[
        'With the step input, compare Mean of 3 (a ramp) with Slope (a single bump where the step is) and Curvature (a bump up and a bump down).',
        'Set padding to 0: the output loses one value at each end for a kernel of 3. Raise it again and the output length returns to 20.',
        'Set stride to 2: about half as many outputs. Then shift the input by one: with stride 1 the output shifts by one too, with stride 2 it changes shape.',
        'Use the spike input with dilation 3: the output copies the kernel, spread out with gaps of two.',
      ]}
      takeaway={
        <>
          The output length is ⌊(N + 2P − D(K − 1) − 1)/S⌋ + 1. A convolution is a fully connected layer whose weight
          matrix is mostly zero, with the same few weights repeated on every row, so it needs K + 1 parameters instead
          of one per input–output pair.
        </>
      }
    >
      <div className="dl-controls">
        <Chips
          options={(Object.keys(SIGNALS) as SignalId[]).map((id) => ({ id, label: SIGNALS[id].label }))}
          value={signal}
          onChange={setSignal}
        />
        <Slider label="Shift input" value={shift} min={0} max={5} step={1} onChange={setShift} show={String} />
      </div>
      <div className="dl-controls">
        <Chips
          options={[
            ...(Object.keys(KERNELS_1D) as KernelId[]).map((id) => ({ id, label: KERNELS_1D[id].label })),
            { id: 'custom' as const, label: 'Custom' },
          ]}
          value={preset}
          onChange={(id) => {
            setPreset(id);
            if (id !== 'custom') setW(KERNELS_1D[id].w);
          }}
        />
        <Slider
          label="Kernel size K"
          value={k}
          min={1}
          max={7}
          step={2}
          onChange={(v) => (setW(resize(w, v)), setPreset('custom'))}
          show={String}
        />
      </div>
      <div className="dl-controls">
        {w.map((v, j) => (
          <Slider
            key={j}
            label={`ω${j + 1}`}
            value={v}
            min={-2}
            max={2}
            step={0.05}
            onChange={(nv) => (setW(w.map((u, i) => (i === j ? nv : u))), setPreset('custom'))}
            show={(u) => u.toFixed(2)}
          />
        ))}
      </div>
      <div className="dl-controls">
        <Slider label="Stride S" value={stride} min={1} max={3} step={1} onChange={setStride} show={String} />
        <Slider label="Padding P" value={pad} min={0} max={3} step={1} onChange={setPad} show={String} />
        <Slider label="Dilation D" value={dil} min={1} max={3} step={1} onChange={setDil} show={String} />
        {len > 0 && (
          <Slider
            label="Output shown"
            value={o}
            min={0}
            max={len - 1}
            step={1}
            onChange={setPickOut}
            show={(v) => `z${v}`}
          />
        )}
      </div>
      <div>
        <Plot
          x={xr}
          y={[lo, hi]}
          height={170}
          xLabel="input position"
          yLabel="input x"
          ariaLabel="The input signal with padding and the inputs used by the selected output"
          draw={(f) => {
            f.hline(0, f.c.muted, [2, 3]);
            const padXs = [
              ...Array.from({ length: pad }, (_, i) => -pad + i),
              ...Array.from({ length: pad }, (_, i) => N1 + i),
            ];
            f.dots(
              padXs.map((p) => [p, 0] as [number, number]),
              f.c.muted,
              3,
            );
            stems(
              f,
              x.map((_, i) => i),
              x,
              f.c.s1,
            );
            if (len > 0) {
              taps.forEach((t, j) => {
                const v = t >= 0 && t < N1 ? x[t] : 0;
                f.dots([[t, v]], f.c.brand, 6);
                f.text(`ω${j + 1}`, t, Math.max(v, 0) + (hi - lo) * 0.08, f.c.brand, 'center');
              });
            }
          }}
        />
        <Plot
          x={xr}
          y={[lo, hi]}
          height={150}
          xLabel="output, drawn at the centre of its kernel"
          yLabel="output z"
          ariaLabel="The convolution output, each value placed under the centre of its kernel"
          draw={(f) => {
            f.hline(0, f.c.muted, [2, 3]);
            stems(
              f,
              z.map((_, i) => centre(i)),
              z,
              f.c.s2,
            );
            if (len > 0) {
              f.vline(centre(o), f.c.brand);
              f.dots([[centre(o), z[o]]], f.c.brand, 6);
            }
          }}
        />
        <p className="dl-caption">
          {len > 0
            ? `z${o} = ${terms.join(' + ')} = ${fmt(z[o], 3)}`
            : 'The kernel is wider than the padded input, so there are no outputs.'}
        </p>
      </div>
      <Readout
        items={[
          ['output length', formula],
          ['inputs spanned by the kernel D(K − 1) + 1', dil * (k - 1) + 1],
          ['parameters: convolution (K + 1)', k + 1],
          ['parameters: fully connected (N·L + L)', N1 * Math.max(0, len) + Math.max(0, len)],
        ]}
      />
      {len > 0 && (
        <Labelled title={`The same layer as a ${len} × ${N1} weight matrix (row ${o} outlined)`}>
          <div className="dl-scroll">
            <Pixels
              img={matrix}
              h={len}
              w={N1}
              cell={12}
              signed
              box={[o, 0, o, N1 - 1]}
              label="Weight matrix of the convolution"
            />
          </div>
          <p className="dl-caption">
            Each row holds the same kernel, moved along by the stride. Weights that fall on padding are dropped.
          </p>
        </Labelled>
      )}
    </Notebook>
  );
}

/* ---------- 10.2 Convolution for MNIST-1D ---------- */

const LEN_1D = 40;
const CLASSES = 10;

/** Ten 12-sample templates, each a different shape, from which the 1D examples are drawn. */
const TEMPLATES_1D: number[][] = [
  [1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1],
  [-1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1],
  [0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0],
  [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0],
  [0, 0, 0, -1, -1, -1, -1, -1, -1, 0, 0, 0],
  Array.from({ length: 12 }, (_, i) => -1 + (2 * i) / 11),
  [0, 0.5, 1, 1.5, 1.5, 1, 0, -1, -1.5, -1.5, -1, -0.5],
  [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
  [0, 0, 0, 0, 0, 1.6, -1.6, 0, 0, 0, 0, 0],
  [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
];

/** One example: a template stretched, scaled and placed at a random position, plus a slope and noise. */
function makeSeries(cls: number, rand: () => number): Float64Array {
  const t = TEMPLATES_1D[cls];
  const len = Math.round(12 * (0.8 + 0.5 * rand()));
  const amp = 0.7 + 0.6 * rand();
  const off = Math.floor(rand() * (LEN_1D - len + 1));
  const slope = (rand() - 0.5) * 0.04;
  const out = new Float64Array(LEN_1D);
  for (let i = 0; i < LEN_1D; i++) out[i] = slope * (i - LEN_1D / 2) + gauss(rand) * 0.25;
  for (let j = 0; j < len; j++) {
    const u = (j / (len - 1)) * 11;
    const a = Math.floor(u);
    const f = u - a;
    out[off + j] += amp * (t[a] * (1 - f) + t[Math.min(11, a + 1)] * f);
  }
  return out;
}

interface DataSet {
  xs: Float64Array[];
  ys: number[];
}

function makeSeriesSet(n: number, seed: number): DataSet {
  const rand = rng(seed);
  const ys = Array.from({ length: n }, (_, i) => i % CLASSES);
  return { xs: ys.map((c) => makeSeries(c, rand)), ys };
}

const CH_1D = 8;

/** Three convolutions (kernel 3, stride 2, no padding), as in the book's network but with 8 channels: 40 → 19 → 9 → 4. */
function convNet1D(seed: number): Net {
  const rand = rng(seed);
  const layer = (ci: number, w: number) =>
    new Conv({ ci, h: 1, w, co: CH_1D, kh: 1, kw: 3, stride: 2, ph: 0, pw: 0 }, rand);
  const c1 = layer(1, LEN_1D);
  const c2 = layer(CH_1D, c1.wo);
  const c3 = layer(CH_1D, c2.wo);
  return new Net([c1, new Relu(), c2, new Relu(), c3, new Relu(), new Dense(CH_1D * c3.wo, CLASSES, rand)]);
}

/** A fully connected network with as many hidden units per layer as the convolutional one: 152, 72 and 32. */
function denseNet1D(seed: number): Net {
  const rand = rng(seed);
  return new Net([
    new Dense(LEN_1D, 152, rand),
    new Relu(),
    new Dense(152, 72, rand),
    new Relu(),
    new Dense(72, 32, rand),
    new Relu(),
    new Dense(32, CLASSES, rand),
  ]);
}

const STEPS_1D = 2500;

interface Run1D {
  data: { train: DataSet; test: DataSet };
  conv: Net;
  dense: Net;
  step: number;
  hist: History[];
  rand: () => number;
}

function newRun1D(data: Run1D['data']): Run1D {
  const r: Run1D = { data, conv: convNet1D(5), dense: denseNet1D(6), step: 0, hist: [], rand: rng(77) };
  record1D(r);
  return r;
}

function record1D(r: Run1D) {
  const { train, test } = r.data;
  r.hist.push({
    step: r.step,
    values: [
      r.conv.accuracy(test.xs, test.ys),
      r.conv.accuracy(train.xs, train.ys, 500),
      r.dense.accuracy(test.xs, test.ys),
      r.dense.accuracy(train.xs, train.ys, 500),
    ],
  });
}

function step1D(r: Run1D) {
  const { train } = r.data;
  const idx = batch(r.rand, train.xs.length, 32);
  r.conv.train(train.xs, train.ys, idx, 0.003);
  r.dense.train(train.xs, train.ys, idx, 0.003);
  r.step++;
  if (r.step % 50 === 0) record1D(r);
}

function Mnist1D() {
  const [size, setSize] = useState<'200' | '500' | '2000'>('500');
  const [seed, setSeed] = useState(1);
  const [cls, setCls] = useState(3);
  const [running, setRunning] = useState(false);
  const [, tick] = useState(0);
  const data = useMemo(
    () => ({ train: makeSeriesSet(+size, 100 + seed), test: makeSeriesSet(500, 900 + seed) }),
    [size, seed],
  );
  const run = useRef<Run1D | null>(null);
  if (!run.current || run.current.data !== data) run.current = newRun1D(data);
  const r = run.current;
  const done = r.step >= STEPS_1D;

  useAnimation(running, () => {
    for (let i = 0; i < 4 && r.step < STEPS_1D; i++) step1D(r);
    tick((n) => n + 1);
    if (r.step >= STEPS_1D) {
      setRunning(false);
      return false;
    }
  });

  const last = r.hist[r.hist.length - 1].values;
  const steps = r.hist.map((h) => h.step);
  const series = (k: number) => r.hist.map((h) => h.values[k]);
  const examples = data.train.xs.filter((_, i) => data.train.ys[i] === cls).slice(0, 3);

  return (
    <Notebook
      id="10.2"
      title="Convolution for MNIST-1D"
      intro={
        <>
          Each example is one of ten 1D shapes, stretched, scaled, placed anywhere in 40 samples and buried in noise.
          Two networks learn to name the shape. The convolutional one has three layers of eight channels (kernel 3,
          stride 2, no padding, so 40 → 19 → 9 → 4 positions) and a final fully connected layer. The fully connected one
          has the same number of hidden units in each layer: 152, 72 and 32. Both train with Adam on the same batches.
        </>
      }
      tryThis={[
        'Press Train and watch the dashed lines: both networks fit the training set perfectly, but the convolutional one does better on new examples (about 68% against 57% with 500 examples).',
        'Choose 200 training examples: the fully connected network has seen each shape at only a few positions, and its test accuracy suffers most.',
        'Choose 2000: the fully connected network catches up, because it now sees every shape at many positions. Convolution helps most when data are scarce.',
      ]}
      takeaway={
        <>
          The convolutional network has about 25 times fewer parameters, yet generalises better from small datasets. It
          is a special case of the fully connected network, forced to treat every position the same way. That matches
          how the data were made, so the restriction helps.
        </>
      }
    >
      <div className="dl-controls">
        <RunButtons
          running={running}
          done={done}
          toggle={() => setRunning((v) => !v)}
          stepOnce={() => (step1D(r), tick((n) => n + 1))}
          reset={() => (setRunning(false), (run.current = newRun1D(data)), tick((n) => n + 1))}
        />
        <span className="small muted">Training examples</span>
        <Chips
          options={[
            { id: '200', label: '200' },
            { id: '500', label: '500' },
            { id: '2000', label: '2000' },
          ]}
          value={size}
          onChange={(v) => (setRunning(false), setSize(v))}
        />
        <button className="btn small" onClick={() => (setRunning(false), setSeed((s) => s + 1))}>
          New data
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, STEPS_1D]}
            y={[0, 1]}
            height={220}
            xLabel="training step"
            yLabel="accuracy"
            ariaLabel="Training and test accuracy of the two networks"
            draw={(f) => {
              f.hline(0.1, f.c.muted, [2, 3]);
              f.line(steps, series(1), f.c.s1, 1.5, [5, 4]);
              f.line(steps, series(3), f.c.s2, 1.5, [5, 4]);
              f.line(steps, series(0), f.c.s1);
              f.line(steps, series(2), f.c.s2);
            }}
          />
          <Legend
            items={[
              ['s1', 'convolutional: test (solid), train (dashed)'],
              ['s2', 'fully connected: test (solid), train (dashed)'],
              ['muted', 'chance, 10%'],
            ]}
          />
        </div>
        <div>
          <Plot
            x={[0, LEN_1D - 1]}
            y={[-3, 3]}
            height={180}
            xLabel="position"
            ariaLabel={`Three training examples of class ${cls}`}
            draw={(f) => {
              const xs = Array.from({ length: LEN_1D }, (_, i) => i);
              examples.forEach((e, i) => f.line(xs, Array.from(e), [f.c.s1, f.c.s3, f.c.s4][i], 1.5));
              const t = TEMPLATES_1D[cls];
              f.line(
                t.map((_, i) => i),
                t,
                f.c.ink,
                2,
                [3, 3],
              );
            }}
          />
          <div className="dl-controls">
            <Slider label="Class" value={cls} min={0} max={9} step={1} onChange={setCls} show={String} />
          </div>
          <p className="dl-caption">
            Three training examples of one class; the dotted line is its template. The shape moves, so its position
            tells you nothing.
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['step', `${r.step} / ${STEPS_1D}`],
          ['convolutional: test accuracy', `${(last[0] * 100).toFixed(1)}%`],
          ['fully connected: test accuracy', `${(last[2] * 100).toFixed(1)}%`],
          ['convolutional: train accuracy', `${(last[1] * 100).toFixed(1)}%`],
          ['fully connected: train accuracy', `${(last[3] * 100).toFixed(1)}%`],
          ['parameters', `${r.conv.count.toLocaleString()} vs ${r.dense.count.toLocaleString()}`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 10.3 2D convolution ---------- */

const N2 = 16;
type ImageId = 'shapes' | 'digit' | 'stripes';
const IMAGES: Record<ImageId, { label: string; make: () => Float64Array }> = {
  shapes: {
    label: 'Square and disc',
    make: () =>
      Float64Array.from({ length: N2 * N2 }, (_, i) => {
        const r = Math.floor(i / N2);
        const c = i % N2;
        if (r >= 2 && r <= 7 && c >= 2 && c <= 7) return 1;
        return Math.hypot(r - 10.5, c - 10.5) < 3.6 ? 0.7 : 0;
      }),
  },
  digit: { label: 'Digit', make: () => drawGlyph(2, N2) },
  stripes: {
    label: 'Stripes',
    make: () => Float64Array.from({ length: N2 * N2 }, (_, i) => ((Math.floor(i / N2) + (i % N2)) % 6 < 3 ? 1 : 0)),
  },
};

type Kernel2D = 'identity' | 'box' | 'gauss' | 'sharpen' | 'sobelx' | 'sobely' | 'laplace';
const KERNELS_2D: Record<Kernel2D, { label: string; k: number[] }> = {
  identity: { label: 'Identity', k: [0, 0, 0, 0, 1, 0, 0, 0, 0] },
  box: { label: 'Box blur', k: Array(9).fill(1 / 9) as number[] },
  gauss: { label: 'Gaussian blur', k: [1, 2, 1, 2, 4, 2, 1, 2, 1].map((v) => v / 16) },
  sharpen: { label: 'Sharpen', k: [0, -1, 0, -1, 5, -1, 0, -1, 0] },
  sobelx: { label: 'Vertical edges', k: [-1, 0, 1, -2, 0, 2, -1, 0, 1] },
  sobely: { label: 'Horizontal edges', k: [-1, -2, -1, 0, 0, 0, 1, 2, 1] },
  laplace: { label: 'All edges', k: [0, 1, 0, 1, -4, 1, 0, 1, 0] },
};

/** A single-channel 3×3 convolution with stride s and zero padding p. */
function conv2d(img: Float64Array, h: number, w: number, k: number[], s: number, p: number) {
  const ho = Math.floor((h + 2 * p - 3) / s) + 1;
  const wo = Math.floor((w + 2 * p - 3) / s) + 1;
  const out = new Float64Array(Math.max(0, ho * wo));
  for (let r = 0; r < ho; r++) {
    for (let c = 0; c < wo; c++) {
      let acc = 0;
      for (let m = 0; m < 3; m++) {
        for (let n = 0; n < 3; n++) {
          const y = r * s + m - p;
          const x = c * s + n - p;
          if (y >= 0 && y < h && x >= 0 && x < w) acc += k[m * 3 + n] * img[y * w + x];
        }
      }
      out[r * wo + c] = acc;
    }
  }
  return { out, ho, wo };
}

function Conv2D() {
  const [image, setImage] = useState<ImageId>('shapes');
  const [preset, setPreset] = useState<Kernel2D | 'custom'>('sobelx');
  const [k, setK] = useState(KERNELS_2D.sobelx.k);
  const [layers, setLayers] = useState(1);
  const [stride, setStride] = useState<'1' | '2'>('1');
  const [padding, setPadding] = useState<'same' | 'valid'>('same');
  const [pickAt, setPickAt] = useState<[number, number]>([4, 2]);
  const img = useMemo(() => IMAGES[image].make(), [image]);
  const s = +stride;
  const p = padding === 'same' ? 1 : 0;
  const maps = [{ out: img, ho: N2, wo: N2 }];
  for (let l = 0; l < layers; l++) {
    const prev = maps[maps.length - 1];
    if (prev.ho < 1 || prev.wo < 1) break;
    maps.push(conv2d(prev.out, prev.ho, prev.wo, k, s, p));
  }
  const final = maps[maps.length - 1];
  const ok = final.ho > 0 && final.wo > 0 && maps.length === layers + 1;
  const pr = clamp(pickAt[0], 0, Math.max(0, final.ho - 1));
  const pc = clamp(pickAt[1], 0, Math.max(0, final.wo - 1));
  // Work back from the picked output to the input region that feeds it.
  let [r0, r1, c0, c1] = [pr, pr, pc, pc];
  for (let l = 0; l < layers; l++) [r0, r1, c0, c1] = [r0 * s - p, r1 * s - p + 2, c0 * s - p, c1 * s - p + 2];
  const field = r1 - r0 + 1;
  const signedOut = ok && Array.from(final.out).some((v) => v < -1e-9);
  const patch = [0, 1, 2].map((m) =>
    [0, 1, 2].map((n) => {
      const y = pr * s + m - p;
      const x = pc * s + n - p;
      return y >= 0 && y < N2 && x >= 0 && x < N2 ? img[y * N2 + x] : 0;
    }),
  );
  let jump = 1;
  let rf = 1;
  for (let l = 0; l < layers; l++) {
    rf += 2 * jump;
    jump *= s;
  }

  return (
    <Notebook
      id="10.3"
      title="2D convolution"
      intro={
        <>
          In 2D the kernel is a small grid of weights, here 3×3. Each output pixel is the weighted sum of the 3×3 patch
          of inputs around it, hᵢⱼ = Σₘ Σₙ ωₘₙ x at (i + m − 2, j + n − 2), and the same nine weights are used at every
          position. There is no bias or activation here, so you see the convolution itself. Stack several layers and
          each output depends on a larger patch of the input: its receptive field.
        </>
      }
      tryThis={[
        'Pick Vertical edges on the square: the output is blue on the left edge, orange on the right and zero inside, where the image is flat.',
        'Pick Gaussian blur and raise the layers to 3: the image blurs more, and the outlined receptive field grows from 3×3 to 7×7.',
        'Set the stride to 2 with 3 layers: the output shrinks to 2×2 and the receptive field jumps to 15×15, because each layer skips every other position.',
        'Type your own weights into the kernel. Weights that sum to 1 keep the brightness; weights that sum to 0 respond only to changes.',
      ]}
      takeaway={
        <>
          Nine weights, shared across the image, can find edges, blur or sharpen anywhere in it. A fully connected layer
          from a 16×16 image to a 16×16 output would need 65,536 weights. Stacking small kernels, or striding, grows the
          receptive field so that later layers see larger structures.
        </>
      }
    >
      <div className="dl-controls">
        <Chips
          options={(Object.keys(IMAGES) as ImageId[]).map((id) => ({ id, label: IMAGES[id].label }))}
          value={image}
          onChange={setImage}
        />
      </div>
      <div className="dl-controls">
        <Chips
          options={[
            ...(Object.keys(KERNELS_2D) as Kernel2D[]).map((id) => ({ id, label: KERNELS_2D[id].label })),
            { id: 'custom' as const, label: 'Custom' },
          ]}
          value={preset}
          onChange={(id) => {
            setPreset(id);
            if (id !== 'custom') setK(KERNELS_2D[id].k);
          }}
        />
      </div>
      <div className="dl-controls">
        <Slider label="Layers" value={layers} min={1} max={3} step={1} onChange={setLayers} show={String} />
        <span className="small muted">Stride</span>
        <Chips
          options={[
            { id: '1', label: '1' },
            { id: '2', label: '2' },
          ]}
          value={stride}
          onChange={setStride}
        />
        <span className="small muted">Padding</span>
        <Chips
          options={[
            { id: 'same', label: 'Zero padding' },
            { id: 'valid', label: 'Valid only' },
          ]}
          value={padding}
          onChange={setPadding}
        />
      </div>
      <div className="dl-cols">
        <Labelled title={`Input, ${N2}×${N2}`}>
          <Pixels
            img={img}
            h={N2}
            w={N2}
            cell={14}
            box={ok ? [Math.max(0, r0), Math.max(0, c0), Math.min(N2 - 1, r1), Math.min(N2 - 1, c1)] : null}
            label="Input image with the receptive field of the picked output outlined"
          />
          <p className="dl-caption">
            The outline is the receptive field of the picked output pixel
            {r0 < 0 || c0 < 0 || r1 >= N2 || c1 >= N2 ? ' (part of it falls on the padding)' : ''}.
          </p>
        </Labelled>
        <Labelled
          title={ok ? `Output after ${layers} layer${layers > 1 ? 's' : ''}, ${final.ho}×${final.wo}` : 'Output'}
        >
          {ok ? (
            <Pixels
              img={final.out}
              h={final.ho}
              w={final.wo}
              cell={Math.min(28, Math.floor((14 * N2) / Math.max(final.ho, final.wo)))}
              signed={signedOut}
              pick={[pr, pc]}
              onCell={(rr, cc) => setPickAt([rr, cc])}
              label="Convolution output; click a pixel to pick it"
            />
          ) : (
            <p className="small muted">The image is too small for this many valid layers.</p>
          )}
          <p className="dl-caption">Click an output pixel to pick it. Blue is positive, orange negative.</p>
        </Labelled>
        <Labelled title="Kernel ω (editable)">
          <table className="dl-table">
            <tbody>
              {[0, 1, 2].map((m) => (
                <tr key={m}>
                  {[0, 1, 2].map((n) => (
                    <td key={n} style={{ padding: 2 }}>
                      <input
                        type="number"
                        step={0.1}
                        value={+k[m * 3 + n].toFixed(3)}
                        aria-label={`kernel weight row ${m + 1} column ${n + 1}`}
                        onChange={(e) => {
                          const v = Number.isFinite(+e.target.value) ? +e.target.value : 0;
                          setK(k.map((u, i) => (i === m * 3 + n ? v : u)));
                          setPreset('custom');
                        }}
                        style={{ width: 60, font: 'inherit', fontSize: 13 }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {layers === 1 && ok && (
            <>
              <div className="small" style={{ fontWeight: 600, margin: '10px 0 4px' }}>
                Patch under the picked pixel
              </div>
              <table className="dl-table">
                <tbody>
                  {patch.map((row, m) => (
                    <tr key={m}>
                      {row.map((v, n) => (
                        <td key={n}>
                          {fmt(k[m * 3 + n], 2)} × {fmt(v, 2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="dl-caption">Sum of the nine products: {fmt(final.out[pr * final.wo + pc], 4)}</p>
            </>
          )}
        </Labelled>
      </div>
      <Readout
        items={[
          ['receptive field', `${field}×${field}`],
          ['rule: r grows by (K − 1) × product of earlier strides', `r = ${rf}`],
          ['output size per layer', maps.map((m) => `${m.ho}×${m.wo}`).join(' → ')],
          [
            'kernel weight sum',
            fmt(
              k.reduce((a, b) => a + b, 0),
              3,
            ),
          ],
          ['parameters per layer', '9 weights + 1 bias'],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 10.4 Downsampling and upsampling ---------- */

const N4 = 8;
type DownId = 'sub' | 'max' | 'mean' | 'strided';
type UpId = 'repeat' | 'unpool' | 'bilinear' | 'transposed';
type Small = 'digit' | 'blob' | 'checker' | 'random';

const SMALL: Record<Small, { label: string; make: () => Float64Array }> = {
  digit: { label: 'Digit', make: () => drawGlyph(7, N4) },
  blob: {
    label: 'Smooth blob',
    make: () =>
      Float64Array.from({ length: N4 * N4 }, (_, i) =>
        Math.exp(-((Math.floor(i / N4) - 3) ** 2 + ((i % N4) - 4.5) ** 2) / 6),
      ),
  },
  checker: {
    label: 'Fine checks',
    make: () => Float64Array.from({ length: N4 * N4 }, (_, i) => (Math.floor(i / N4) + i) % 2),
  },
  random: {
    label: 'Random',
    make: () => {
      const rand = rng(12);
      return Float64Array.from({ length: N4 * N4 }, () => Math.round(rand() * 10) / 10);
    },
  },
};

const TENT = [1, 2, 1, 2, 4, 2, 1, 2, 1].map((v) => v / 16);

function downsample(x: Float64Array, how: DownId) {
  const n = N4 / 2;
  const out = new Float64Array(n * n);
  const from = new Int32Array(n * n);
  if (how === 'strided') return { out: conv2d(x, N4, N4, TENT, 2, 1).out, from };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cells = [0, 1, 2, 3].map((q) => (2 * r + (q >> 1)) * N4 + 2 * c + (q & 1));
      const o = r * n + c;
      if (how === 'sub') out[o] = x[cells[0]];
      else if (how === 'mean') out[o] = (x[cells[0]] + x[cells[1]] + x[cells[2]] + x[cells[3]]) / 4;
      else {
        from[o] = cells.reduce((best, i) => (x[i] > x[best] ? i : best), cells[0]);
        out[o] = x[from[o]];
      }
    }
  }
  return { out, from };
}

/** Transposed convolution, stride 2, padding 1, kernel ω⊗ω: each input pixel adds a scaled copy of the kernel to the output. */
function transposedConv(x: Float64Array, n: number, w: number[]): Float64Array {
  const size = 2 * n;
  const out = new Float64Array(size * size);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          const r = 2 * i + a - 1;
          const c = 2 * j + b - 1;
          if (r >= 0 && r < size && c >= 0 && c < size) out[r * size + c] += x[i * n + j] * w[a] * w[b];
        }
      }
    }
  }
  return out;
}

function upsample(x: Float64Array, how: UpId, from: Int32Array, w: number[]): Float64Array {
  const n = N4 / 2;
  if (how === 'transposed') return transposedConv(x, n, w);
  const out = new Float64Array(N4 * N4);
  if (how === 'unpool') {
    from.forEach((at, o) => (out[at] = x[o]));
    return out;
  }
  for (let r = 0; r < N4; r++) {
    for (let c = 0; c < N4; c++) {
      if (how === 'repeat') out[r * N4 + c] = x[(r >> 1) * n + (c >> 1)];
      else {
        // Bilinear: output pixel centres mapped back onto the input grid, clamped at the edges.
        const u = clamp((r + 0.5) / 2 - 0.5, 0, n - 1);
        const v = clamp((c + 0.5) / 2 - 0.5, 0, n - 1);
        const [r0, c0] = [Math.floor(u), Math.floor(v)];
        const [r1, c1] = [Math.min(n - 1, r0 + 1), Math.min(n - 1, c0 + 1)];
        const [fu, fv] = [u - r0, v - c0];
        out[r * N4 + c] =
          (1 - fu) * ((1 - fv) * x[r0 * n + c0] + fv * x[r0 * n + c1]) +
          fu * ((1 - fv) * x[r1 * n + c0] + fv * x[r1 * n + c1]);
      }
    }
  }
  return out;
}

function DownUp() {
  const [image, setImage] = useState<Small>('digit');
  const [down, setDown] = useState<DownId>('max');
  const [up, setUp] = useState<UpId>('bilinear');
  const [w, setW] = useState([0.5, 1, 0.5]);
  const x = useMemo(() => SMALL[image].make(), [image]);
  const d = downsample(x, down);
  const upHow: UpId = up === 'unpool' && down !== 'max' ? 'repeat' : up;
  const y = upsample(d.out, upHow, d.from, w);
  const mse = Array.from(x).reduce((a, v, i) => a + (v - y[i]) ** 2, 0) / x.length;
  const max = Math.max(1, ...Array.from(y));
  // The 1D matrices of figure 10.13's kind: stride-2 convolution (8 → 4) and its transpose (4 → 8).
  const C = new Float64Array(4 * 8);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) if (2 * i + j - 1 >= 0) C[i * 8 + 2 * i + j - 1] = w[j];
  const Ct = new Float64Array(8 * 4);
  for (let i = 0; i < 4; i++) for (let r = 0; r < 8; r++) Ct[r * 4 + i] = C[i * 8 + r];
  const params =
    { sub: 0, max: 0, mean: 0, strided: 9 }[down] + { repeat: 0, unpool: 0, bilinear: 0, transposed: 9 }[upHow];

  return (
    <Notebook
      id="10.4"
      title="Downsampling and upsampling"
      intro={
        <>
          Networks shrink their feature maps to see more of the image per unit, and image-to-image networks grow them
          again. Here an 8×8 map is halved to 4×4 and then doubled back to 8×8. Downsampling keeps every other pixel,
          takes the largest or the mean of each 2×2 block, or uses a stride-2 convolution. Upsampling repeats each
          value, puts each maximum back where it came from (max unpooling), interpolates bilinearly, or uses a
          transposed convolution.
        </>
      }
      tryThis={[
        'On Fine checks, compare subsampling (all one colour), max pooling (all 1) and mean pooling (all 0.5): each loses the pattern differently.',
        'Use max pooling with max unpooling: the maxima return to their places and everything else is 0.',
        'With the transposed convolution and ω = [0.5, 1, 0.5] the result matches linear interpolation away from the edges. Set ω to [1, 1, 1]: overlapping copies add up unevenly and a checkerboard appears.',
        'Compare the two matrices below: upsampling by transposed convolution uses exactly the transpose of the downsampling matrix.',
      ]}
      takeaway={
        <>
          Pooling and repetition have no parameters; strided and transposed convolutions learn their kernels. Pooling is
          applied to each channel separately, so only the height and width change. Information thrown away by
          downsampling cannot be recovered exactly, whichever way you upsample.
        </>
      }
    >
      <div className="dl-controls">
        <Chips
          options={(Object.keys(SMALL) as Small[]).map((id) => ({ id, label: SMALL[id].label }))}
          value={image}
          onChange={setImage}
        />
      </div>
      <div className="dl-controls">
        <span className="small muted">Down</span>
        <Chips
          options={[
            { id: 'sub', label: 'Subsample' },
            { id: 'max', label: 'Max pool' },
            { id: 'mean', label: 'Mean pool' },
            { id: 'strided', label: 'Stride-2 conv (blur)' },
          ]}
          value={down}
          onChange={setDown}
        />
      </div>
      <div className="dl-controls">
        <span className="small muted">Up</span>
        <Chips
          options={[
            { id: 'repeat', label: 'Repeat' },
            { id: 'unpool', label: 'Max unpool' },
            { id: 'bilinear', label: 'Bilinear' },
            { id: 'transposed', label: 'Transposed conv' },
          ]}
          value={up}
          onChange={setUp}
        />
        {w.map((v, j) => (
          <Slider
            key={j}
            label={`ω${j + 1}`}
            value={v}
            min={-1}
            max={2}
            step={0.05}
            onChange={(nv) => setW(w.map((u, i) => (i === j ? nv : u)))}
            show={(u) => u.toFixed(2)}
          />
        ))}
      </div>
      {up === 'unpool' && down !== 'max' && (
        <p className="small muted">
          Max unpooling needs max pooling to remember where the maxima were; repeating instead.
        </p>
      )}
      <div className="dl-cols">
        <Labelled title="Input, 8×8">
          <Pixels img={x} h={N4} w={N4} cell={32} digits={1} max={1} label="Input map" />
        </Labelled>
        <Labelled title="Down, 4×4">
          <Pixels img={d.out} h={4} w={4} cell={32} digits={2} max={1} label="Downsampled map" />
        </Labelled>
        <Labelled title="Up again, 8×8">
          <Pixels img={y} h={N4} w={N4} cell={32} digits={1} max={max} label="Upsampled map" />
        </Labelled>
      </div>
      <Readout
        items={[
          ['shapes', '8×8 → 4×4 → 8×8'],
          ['mean squared error against the input', fmt(mse, 3)],
          ['learned parameters (one channel)', params],
        ]}
      />
      <div className="dl-cols">
        <Labelled title="1D stride-2 convolution with ω as a matrix: 8 inputs → 4 outputs">
          <Pixels img={C} h={4} w={8} cell={26} digits={2} signed label="Downsampling matrix" />
        </Labelled>
        <Labelled title="Its transpose: 4 inputs → 8 outputs (transposed convolution)">
          <Pixels img={Ct} h={8} w={4} cell={26} digits={2} signed label="Transposed convolution matrix" />
        </Labelled>
      </div>
      <p className="dl-caption">
        In the transpose each input feeds three outputs and every other output gets two contributions. The 2D layer
        above does this along both rows and columns, with kernel ω⊗ω.
      </p>
    </Notebook>
  );
}

/* ---------- 10.5 Convolution for digit images ---------- */

const N5 = 12;
const STEPS_2D = 1500;

function makeGlyphSet(n: number, seed: number): DataSet {
  const rand = rng(seed);
  const ys = Array.from({ length: n }, (_, i) => i % CLASSES);
  return { xs: ys.map((c) => drawGlyph(c, N5, rand, 0.08)), ys };
}

/** conv 3×3 (6 channels) → ReLU → max pool → conv 3×3 (8 channels) → ReLU → max pool → dense: 12×12 → 6×6 → 3×3. */
function glyphNet(seed: number): Net {
  const rand = rng(seed);
  return new Net([
    new Conv({ ci: 1, h: N5, w: N5, co: 6, kh: 3, kw: 3, stride: 1, ph: 1, pw: 1 }, rand),
    new Relu(),
    new MaxPool(6, N5, N5),
    new Conv({ ci: 6, h: 6, w: 6, co: 8, kh: 3, kw: 3, stride: 1, ph: 1, pw: 1 }, rand),
    new Relu(),
    new MaxPool(8, 6, 6),
    new Dense(72, CLASSES, rand),
  ]);
}

interface Run2D {
  data: { train: DataSet; test: DataSet };
  net: Net;
  step: number;
  hist: History[];
  rand: () => number;
}

function newRun2D(data: Run2D['data'], seed: number): Run2D {
  const r: Run2D = { data, net: glyphNet(seed), step: 0, hist: [], rand: rng(31 + seed) };
  record2D(r);
  return r;
}

function record2D(r: Run2D) {
  r.hist.push({
    step: r.step,
    values: [r.net.accuracy(r.data.test.xs, r.data.test.ys), r.net.accuracy(r.data.train.xs, r.data.train.ys, 300)],
  });
}

function step2D(r: Run2D) {
  r.net.train(r.data.train.xs, r.data.train.ys, batch(r.rand, r.data.train.xs.length, 16), 0.005);
  r.step++;
  if (r.step % 25 === 0) record2D(r);
}

function Mnist2D() {
  const [seed, setSeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [, tick] = useState(0);
  const [pad, setPad] = useState<Float64Array>(() => drawGlyph(3, N5, rng(5), 0.05));
  const data = useMemo(() => ({ train: makeGlyphSet(600, 40), test: makeGlyphSet(300, 41) }), []);
  const run = useRef<Run2D | null>(null);
  if (!run.current) run.current = newRun2D(data, seed);
  const r = run.current;
  const done = r.step >= STEPS_2D;

  useAnimation(running, () => {
    for (let i = 0; i < 3 && r.step < STEPS_2D; i++) step2D(r);
    tick((n) => n + 1);
    if (r.step >= STEPS_2D) {
      setRunning(false);
      return false;
    }
  });

  const probs = r.net.probs(pad);
  const maps = r.net.acts[2];
  const conv1 = r.net.layers[0] as Conv;
  const guess = argmax(probs);
  const last = r.hist[r.hist.length - 1].values;
  const samples = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => (
        <Pixels key={i} img={data.test.xs[i]} h={N5} w={N5} cell={4} label={`Test digit ${data.test.ys[i]}`} />
      )),
    [data],
  );
  const paint = (row: number, col: number) =>
    setPad((cur) => {
      const next = cur.slice();
      for (const [dr, dc, v] of [
        [0, 0, 1],
        [1, 0, 0.6],
        [-1, 0, 0.6],
        [0, 1, 0.6],
        [0, -1, 0.6],
      ]) {
        const rr = row + dr;
        const cc = col + dc;
        if (rr >= 0 && rr < N5 && cc >= 0 && cc < N5) next[rr * N5 + cc] = Math.max(next[rr * N5 + cc], v);
      }
      return next;
    });

  return (
    <Notebook
      id="10.5"
      title="Convolution for MNIST"
      intro={
        <>
          A small convolutional network learns to read 12×12 digit-like glyphs, drawn here in code with random size,
          slant, position, thickness and noise. Two blocks of 3×3 convolution, ReLU and 2×2 max pooling take the image
          from 12×12 to 6×6 to 3×3, with 6 and then 8 channels, and a fully connected layer maps the 72 values to ten
          class scores. It has 1,230 parameters and trains with Adam on 600 examples.
        </>
      }
      tryThis={[
        'Press Train. Test accuracy usually passes 90% within a few hundred steps.',
        'Watch the first-layer kernels: they start as noise and settle into small stroke and edge detectors.',
        'Draw your own digit in the pad (drag to paint), and see the feature maps and the prediction change as you draw.',
        'Press New weights and train again: the kernels come out different each time, but the accuracy is similar.',
      ]}
      takeaway={
        <>
          The kernels are not designed: they are learned, and they end up looking like the hand-made edge filters of
          10.3. The pooling layers make the answer depend less on exactly where the strokes are.
        </>
      }
    >
      <div className="dl-controls">
        <RunButtons
          running={running}
          done={done}
          toggle={() => setRunning((v) => !v)}
          stepOnce={() => (step2D(r), tick((n) => n + 1))}
          reset={() => (setRunning(false), (run.current = newRun2D(data, seed)), tick((n) => n + 1))}
        />
        <button
          className="btn small"
          onClick={() => {
            setRunning(false);
            setSeed(seed + 1);
            run.current = newRun2D(data, seed + 1);
          }}
        >
          New weights
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, STEPS_2D]}
            y={[0, 1]}
            height={200}
            xLabel="training step"
            yLabel="accuracy"
            ariaLabel="Training and test accuracy of the digit network"
            draw={(f) => {
              const steps = r.hist.map((h) => h.step);
              f.hline(0.1, f.c.muted, [2, 3]);
              f.line(
                steps,
                r.hist.map((h) => h.values[1]),
                f.c.s1,
                1.5,
                [5, 4],
              );
              f.line(
                steps,
                r.hist.map((h) => h.values[0]),
                f.c.s1,
              );
            }}
          />
          <Legend
            items={[
              ['s1', 'test (solid), train (dashed)'],
              ['muted', 'chance, 10%'],
            ]}
          />
          <Readout
            items={[
              ['step', `${r.step} / ${STEPS_2D}`],
              ['test accuracy', `${(last[0] * 100).toFixed(1)}%`],
              ['train accuracy', `${(last[1] * 100).toFixed(1)}%`],
              ['parameters', r.net.count.toLocaleString()],
            ]}
          />
        </div>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            Some test digits and the network&apos;s answers
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, auto)', gap: 6, justifyContent: 'start' }}>
            {samples.map((el, i) => {
              const g = argmax(r.net.forward(data.test.xs[i]));
              return (
                <div key={i} style={{ textAlign: 'center' }}>
                  {el}
                  <span className="small mono" style={{ color: g === data.test.ys[i] ? 'var(--good)' : 'var(--bad)' }}>
                    {g}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="dl-caption">Green answers are right, red are wrong.</p>
        </div>
      </div>
      <div className="dl-cols">
        <Labelled title="Draw a digit">
          <Pixels img={pad} h={N5} w={N5} cell={16} max={1} onCell={paint} label="Drawing pad: drag to paint" />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small" onClick={() => setPad(new Float64Array(N5 * N5))}>
              Clear
            </button>
            <button
              className="btn small"
              onClick={() => setPad(data.test.xs[Math.floor(Math.random() * data.test.xs.length)])}
            >
              Random test digit
            </button>
          </div>
        </Labelled>
        <Labelled title={`Prediction: ${guess} (${(probs[guess] * 100).toFixed(0)}%)`}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto',
              gap: '3px 8px',
              alignItems: 'center',
              minWidth: 180,
            }}
          >
            {Array.from(probs).map((p, c) => (
              <div key={c} style={{ display: 'contents' }}>
                <span className="mono small">{c}</span>
                <div
                  style={{
                    height: 8,
                    width: `${p * 100}%`,
                    background: c === guess ? 'var(--brand)' : 'var(--s1)',
                    borderRadius: 3,
                  }}
                />
                <span className="mono small">{(p * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </Labelled>
        <Labelled title="First-layer kernels (3×3) and their feature maps">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 8, justifyContent: 'start' }}>
            {Array.from({ length: 6 }, (_, c) => (
              <div key={c}>
                <Pixels
                  img={conv1.W.subarray(c * 9, c * 9 + 9)}
                  h={3}
                  w={3}
                  cell={14}
                  signed
                  label={`Kernel ${c + 1}`}
                />
                <div style={{ height: 4 }} />
                <Pixels
                  img={maps.subarray(c * N5 * N5, (c + 1) * N5 * N5)}
                  h={N5}
                  w={N5}
                  cell={4}
                  label={`Feature map ${c + 1}`}
                />
              </div>
            ))}
          </div>
          <p className="dl-caption">
            Kernels: blue positive, orange negative. Maps: the drawn digit after the kernel and ReLU.
          </p>
        </Labelled>
      </div>
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 10,
    title: 'Convolutional networks',
    blurb:
      'Convolutional layers reuse a few weights at every position, so they need far fewer parameters than fully connected layers and treat a pattern the same wherever it appears.',
    notebooks: [
      { id: '10.1', title: '1D convolution', Component: Conv1D },
      { id: '10.2', title: 'Convolution for MNIST-1D', Component: Mnist1D },
      { id: '10.3', title: '2D convolution', Component: Conv2D },
      { id: '10.4', title: 'Downsampling and upsampling', Component: DownUp },
      { id: '10.5', title: 'Convolution for MNIST', Component: Mnist2D },
    ],
  },
];
