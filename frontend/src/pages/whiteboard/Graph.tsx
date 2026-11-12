import { useEffect, useMemo, useRef, useState } from 'react';
import { compile } from './mathExpr';

export interface Param {
  name: string;
  value: number;
  min: number;
  max: number;
}

const COLOURS = ['#f87171', '#38bdf8', '#4ade80', '#fbbf24'];
const SAMPLES = 600;

/** A tidy step for grid lines: 1, 2 or 5 times a power of ten, about `target` lines across the range. */
function step(range: number, target = 10) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10;
}

/**
 * Functions plotted on a grid, with a slider for every parameter. The y range is worked out once per board from the
 * parameters' extremes, so the axes stay still while the sliders move and the curve visibly changes.
 */
export function Graph({
  functions,
  params,
  xRange,
}: {
  functions: { expression: string; label: string }[];
  params: Param[];
  xRange: [number, number];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(params.map((p) => [p.name, p.value])),
  );
  useEffect(() => setValues(Object.fromEntries(params.map((p) => [p.name, p.value]))), [params]);

  const compiled = useMemo(
    () =>
      functions.map((f) => {
        try {
          return {
            ...f,
            fn: compile(
              f.expression,
              params.map((p) => p.name),
            ),
            error: '',
          };
        } catch (err) {
          return { ...f, fn: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    [functions, params],
  );

  // The y range: every function at the parameters' minimum, value and maximum (up to three parameters).
  const yRange = useMemo<[number, number]>(() => {
    const ys: number[] = [];
    const combos = params
      .slice(0, 3)
      .reduce<Record<string, number>[]>(
        (acc, p) => acc.flatMap((c) => [p.min, p.value, p.max].map((v) => ({ ...c, [p.name]: v }))),
        [{}],
      );
    const base = Object.fromEntries(params.map((p) => [p.name, p.value]));
    for (const f of compiled) {
      if (!f.fn) continue;
      for (const c of combos) {
        for (let i = 0; i <= 200; i++) {
          const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / 200;
          const y = f.fn({ ...base, ...c, x });
          if (Number.isFinite(y) && Math.abs(y) < 1e6) ys.push(y);
        }
      }
    }
    if (!ys.length) return [-5, 5];
    ys.sort((a, b) => a - b);
    let lo = ys[Math.floor(ys.length * 0.02)];
    let hi = ys[Math.ceil(ys.length * 0.98) - 1];
    if (hi - lo < 2) [lo, hi] = [(lo + hi) / 2 - 1, (lo + hi) / 2 + 1];
    const pad = (hi - lo) * 0.1;
    return [Math.min(lo - pad, -1), Math.max(hi + pad, 1)];
  }, [compiled, params, xRange]);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = c.getBoundingClientRect();
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [x0, x1] = xRange;
    const [y0, y1] = yRange;
    const X = (x: number) => ((x - x0) / (x1 - x0)) * width;
    const Y = (y: number) => height - ((y - y0) / (y1 - y0)) * height;

    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    for (const [lo, hi, s, vertical] of [
      [x0, x1, step(x1 - x0), true],
      [y0, y1, step(y1 - y0, 8), false],
    ] as const) {
      for (let t = Math.ceil(lo / s) * s; t <= hi; t += s) {
        const v = Math.abs(t) < s / 1000 ? 0 : t;
        ctx.strokeStyle = v === 0 ? '#cbd5e1' : '#374151';
        ctx.lineWidth = v === 0 ? 1.5 : 1;
        ctx.beginPath();
        if (vertical) {
          ctx.moveTo(X(v), 0);
          ctx.lineTo(X(v), height);
        } else {
          ctx.moveTo(0, Y(v));
          ctx.lineTo(width, Y(v));
        }
        ctx.stroke();
        if (v !== 0) {
          ctx.fillStyle = '#9ca3af';
          const label = String(Math.round(v * 100) / 100);
          if (vertical) ctx.fillText(label, X(v) + 2, Math.min(height - 4, Math.max(12, Y(0) + 12)));
          else ctx.fillText(label, Math.min(width - 28, Math.max(2, X(0) + 4)), Y(v) - 2);
        }
      }
    }
    compiled.forEach((f, i) => {
      if (!f.fn) return;
      ctx.strokeStyle = COLOURS[i % COLOURS.length];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= SAMPLES; k++) {
        const x = x0 + ((x1 - x0) * k) / SAMPLES;
        const y = f.fn({ ...values, x });
        const ok = Number.isFinite(y) && y > y0 - (y1 - y0) && y < y1 + (y1 - y0);
        if (!ok) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(X(x), Y(y));
        else ctx.moveTo(X(x), Y(y));
        pen = true;
      }
      ctx.stroke();
    });
  }, [compiled, values, xRange, yRange]);

  return (
    <div className="wb-graph">
      <canvas ref={canvas} className="wb-plot" role="img" aria-label={functions.map((f) => f.label).join(', ')} />
      <div className="wb-legend">
        {compiled.map((f, i) => (
          <span key={i}>
            <i style={{ background: COLOURS[i % COLOURS.length] }} />
            {f.label || f.expression}
            {f.error && <b className="wb-bad"> · {f.error}</b>}
          </span>
        ))}
      </div>
      {params.map((p) => (
        <label key={p.name} className="wb-slider">
          <b>{p.name}</b>
          <input
            type="range"
            min={p.min}
            max={p.max}
            step={(p.max - p.min) / 200}
            value={values[p.name] ?? p.value}
            onChange={(e) => setValues((v) => ({ ...v, [p.name]: +e.target.value }))}
          />
          <span className="mono">{(values[p.name] ?? p.value).toFixed(2)}</span>
        </label>
      ))}
    </div>
  );
}
