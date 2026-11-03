import { useEffect, useRef, useState, type PointerEvent } from 'react';

/** Theme colours, read from the page's CSS variables each time a plot draws. */
export interface Colours {
  ink: string;
  ink2: string;
  muted: string;
  line: string;
  surface: string;
  brand: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  s5: string;
  good: string;
  bad: string;
}

/** What a draw function gets: the canvas, the scales between data and pixels, and drawing helpers in data units. */
export interface Frame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  c: Colours;
  x: (v: number) => number; // data → pixels
  y: (v: number) => number;
  ix: (px: number) => number; // pixels → data
  iy: (px: number) => number;
  line: (xs: number[], ys: number[], colour: string, width?: number, dash?: number[]) => void;
  dots: (points: [number, number][], colour: string, radius?: number) => void;
  /** Colours each cell of the plot by fn(x, y), in a grid of `cells` across. */
  heat: (fn: (x: number, y: number) => string, cells?: number) => void;
  text: (s: string, x: number, y: number, colour?: string, align?: CanvasTextAlign) => void;
  vline: (x: number, colour: string, dash?: number[]) => void;
  hline: (y: number, colour: string, dash?: number[]) => void;
}

interface Props {
  x: [number, number];
  y: [number, number];
  height?: number;
  /** Draws the contents; axes are drawn first, unless `axes` is false. */
  draw: (f: Frame) => void;
  axes?: boolean;
  xLabel?: string;
  yLabel?: string;
  /** Called with data coordinates while the pointer is pressed and moved, e.g. to drag a point. */
  onDrag?: (x: number, y: number, phase: 'start' | 'move' | 'end') => void;
  ariaLabel: string;
}

const PAD = { l: 38, r: 10, t: 10, b: 26 };

function colours(): Colours {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) => s.getPropertyValue(`--${n}`).trim() || fallback;
  return {
    ink: v('ink', '#1f2937'), ink2: v('ink2', '#4b5563'), muted: v('muted', '#6b7280'), line: v('line', '#e5e7eb'),
    surface: v('surface', '#fff'), brand: v('brand', '#5b4fd6'), s1: v('s1', '#2a78d6'), s2: v('s2', '#eb6834'),
    s3: v('s3', '#1baf7a'), s4: v('s4', '#eda100'), s5: v('s5', '#e87ba4'), good: v('good', '#15803d'), bad: v('bad', '#b91c1c'),
  };
}

function ticks(lo: number, hi: number, count = 5): number[] {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(+t.toPrecision(10));
  return out;
}

/** A canvas chart that fills its container's width, redraws on every render and on a theme change. */
export function Plot({ x, y, height = 240, draw, axes = true, xLabel, yLabel, onDrag, ariaLabel }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [, setTheme] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    const redraw = () => setTheme((n) => n + 1);
    const media = matchMedia('(prefers-color-scheme: dark)');
    document.addEventListener('themechange', redraw);
    media.addEventListener('change', redraw);
    return () => {
      ro.disconnect();
      document.removeEventListener('themechange', redraw);
      media.removeEventListener('change', redraw);
    };
  }, []);

  const pw = Math.max(1, width - PAD.l - PAD.r);
  const ph = height - PAD.t - PAD.b;
  const sx = (v: number) => PAD.l + ((v - x[0]) / (x[1] - x[0])) * pw;
  const sy = (v: number) => PAD.t + ph - ((v - y[0]) / (y[1] - y[0])) * ph;
  const ix = (px: number) => x[0] + ((px - PAD.l) / pw) * (x[1] - x[0]);
  const iy = (py: number) => y[0] + ((PAD.t + ph - py) / ph) * (y[1] - y[0]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !width) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = width * dpr;
    el.height = height * dpr;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const c = colours();
    ctx.font = '11px system-ui, sans-serif';
    const f: Frame = {
      ctx, w: width, h: height, c, x: sx, y: sy, ix, iy,
      line(xs, ys, colour, lw = 2, dash = []) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD.l, PAD.t, pw, ph);
        ctx.clip();
        ctx.strokeStyle = colour;
        ctx.lineWidth = lw;
        ctx.setLineDash(dash);
        ctx.beginPath();
        let pen = false;
        xs.forEach((xv, i) => {
          const yv = ys[i];
          if (!Number.isFinite(yv)) return void (pen = false);
          if (pen) ctx.lineTo(sx(xv), sy(yv));
          else ctx.moveTo(sx(xv), sy(yv));
          pen = true;
        });
        ctx.stroke();
        ctx.restore();
      },
      dots(points, colour, r = 3.5) {
        ctx.fillStyle = colour;
        for (const [px, py] of points) {
          ctx.beginPath();
          ctx.arc(sx(px), sy(py), r, 0, Math.PI * 2);
          ctx.fill();
        }
      },
      heat(fn, cells = 60) {
        const rows = Math.max(1, Math.round((cells * ph) / pw));
        const cw = pw / cells, ch = ph / rows;
        for (let i = 0; i < cells; i++) {
          for (let j = 0; j < rows; j++) {
            ctx.fillStyle = fn(ix(PAD.l + (i + 0.5) * cw), iy(PAD.t + (j + 0.5) * ch));
            ctx.fillRect(PAD.l + i * cw, PAD.t + j * ch, cw + 0.6, ch + 0.6);
          }
        }
      },
      text(s, tx, ty, colour = c.ink2, align = 'left') {
        ctx.fillStyle = colour;
        ctx.textAlign = align;
        ctx.fillText(s, sx(tx), sy(ty));
      },
      vline(v, colour, dash = [4, 4]) {
        f.line([v, v], [y[0], y[1]], colour, 1, dash);
      },
      hline(v, colour, dash = [4, 4]) {
        f.line([x[0], x[1]], [v, v], colour, 1, dash);
      },
    };
    if (axes) {
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.fillStyle = c.muted;
      for (const t of ticks(x[0], x[1])) {
        ctx.beginPath(); ctx.moveTo(sx(t), PAD.t); ctx.lineTo(sx(t), PAD.t + ph); ctx.stroke();
        ctx.textAlign = 'center'; ctx.fillText(String(t), sx(t), PAD.t + ph + 14);
      }
      for (const t of ticks(y[0], y[1], 4)) {
        ctx.beginPath(); ctx.moveTo(PAD.l, sy(t)); ctx.lineTo(PAD.l + pw, sy(t)); ctx.stroke();
        ctx.textAlign = 'right'; ctx.fillText(String(t), PAD.l - 5, sy(t) + 4);
      }
      ctx.textAlign = 'right';
      if (xLabel) ctx.fillText(xLabel, PAD.l + pw, PAD.t + ph + 24 > height ? height - 2 : PAD.t + ph + 24);
      if (yLabel) { ctx.textAlign = 'left'; ctx.fillText(yLabel, PAD.l + 4, PAD.t + 10); }
    }
    draw(f);
  });

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [ix(e.clientX - r.left), iy(e.clientY - r.top)] as const;
  };

  return (
    <div className="dl-plot">
      <canvas
        ref={canvas}
        role="img"
        aria-label={ariaLabel}
        style={{ width: '100%', height, cursor: onDrag ? 'crosshair' : undefined, touchAction: onDrag ? 'none' : undefined }}
        onPointerDown={onDrag && ((e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onDrag(...at(e), 'start'); })}
        onPointerMove={onDrag && ((e) => dragging.current && onDrag(...at(e), 'move'))}
        onPointerUp={onDrag && ((e) => { dragging.current = false; onDrag(...at(e), 'end'); })}
      />
    </div>
  );
}

/** A colour between two hex colours (t from 0 to 1), for heat maps. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ca, cb] = [p(a.length === 4 ? `#${[...a.slice(1)].map((d) => d + d).join('')}` : a), p(b.length === 4 ? `#${[...b.slice(1)].map((d) => d + d).join('')}` : b)];
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * k)).join(',')})`;
}
