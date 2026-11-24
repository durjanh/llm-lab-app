import { useRef, type PointerEvent } from 'react';
import './plot.css';

/*
  A small SVG line plot shared by the tuning, model evaluation and capstone pages: lines, shaded bands, markers,
  reference lines and axes. Colours come from CSS classes (pl-s1 … pl-s5, pl-good, pl-bad, pl-muted), so the plot
  follows the page's light or dark theme. A click reports the data coordinates, for plots the reader adds points to.
*/

export interface Series {
  points: [number, number][];
  cls: string;
  dashed?: boolean;
  thin?: boolean;
}

export interface Band {
  upper: [number, number][];
  lower: [number, number][];
  cls: string;
}

export interface Marker {
  x: number;
  y: number;
  cls: string;
  r?: number;
  label?: string;
}

export interface RefLine {
  at: number;
  cls: string;
  label?: string;
}

export interface PlotProps {
  aria: string;
  xDomain: [number, number];
  yDomain: [number, number];
  series?: Series[];
  bands?: Band[];
  markers?: Marker[];
  vlines?: RefLine[];
  hlines?: RefLine[];
  xTicks?: number[];
  yTicks?: number[];
  fmtX?: (v: number) => string;
  fmtY?: (v: number) => string;
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
  onPick?: (x: number, y: number) => void;
}

const PAD = { l: 44, r: 12, t: 10, b: 34 };

const ticks = ([a, b]: [number, number], n = 5) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

export function Plot(p: PlotProps) {
  const W = p.width ?? 560;
  const H = p.height ?? 240;
  const svg = useRef<SVGSVGElement>(null);
  const [x0, x1] = p.xDomain;
  const [y0, y1] = p.yDomain;
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - ((y - y0) / (y1 - y0 || 1)) * (H - PAD.t - PAD.b);
  const clampY = (y: number) => Math.min(Math.max(y, y0 - (y1 - y0)), y1 + (y1 - y0));
  const path = (pts: [number, number][]) =>
    pts.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(clampY(y)).toFixed(1)}`).join('');
  const fx = p.fmtX ?? ((v: number) => String(+v.toFixed(2)));
  const fy = p.fmtY ?? ((v: number) => String(+v.toFixed(2)));

  function pick(e: PointerEvent<SVGSVGElement>) {
    if (!p.onPick || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    const x = x0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    const y = y0 + ((H - PAD.b - py) / (H - PAD.t - PAD.b)) * (y1 - y0);
    if (x >= x0 && x <= x1) p.onPick(x, y);
  }

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      className={`pl-svg${p.onPick ? ' pl-pick' : ''}`}
      role="img"
      aria-label={p.aria}
      onPointerDown={p.onPick ? pick : undefined}
    >
      <defs>
        <clipPath id={`pl-clip-${W}-${H}`}>
          <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} />
        </clipPath>
      </defs>
      {(p.yTicks ?? ticks(p.yDomain, 4)).map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} className="pl-grid" />
          <text x={PAD.l - 6} y={sy(t) + 4} textAnchor="end" className="pl-tick">
            {fy(t)}
          </text>
        </g>
      ))}
      {(p.xTicks ?? ticks(p.xDomain, 5)).map((t) => (
        <text key={`x${t}`} x={sx(t)} y={H - PAD.b + 15} textAnchor="middle" className="pl-tick">
          {fx(t)}
        </text>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="pl-axis" />
      <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} className="pl-axis" />
      <g clipPath={`url(#pl-clip-${W}-${H})`}>
        {p.bands?.map((b, i) => (
          <path
            key={`b${i}`}
            d={`${path(b.upper)}${path([...b.lower].reverse()).replace('M', 'L')}Z`}
            className={`pl-band ${b.cls}`}
          />
        ))}
        {p.hlines?.map((l) => (
          <line
            key={`h${l.at}${l.cls}`}
            x1={PAD.l}
            x2={W - PAD.r}
            y1={sy(l.at)}
            y2={sy(l.at)}
            className={`pl-ref ${l.cls}`}
          />
        ))}
        {p.vlines?.map((l) => (
          <line
            key={`v${l.at}${l.cls}`}
            x1={sx(l.at)}
            x2={sx(l.at)}
            y1={PAD.t}
            y2={H - PAD.b}
            className={`pl-ref ${l.cls}`}
          />
        ))}
        {p.series?.map((s, i) => (
          <path
            key={`s${i}`}
            d={path(s.points)}
            className={`pl-line ${s.cls}${s.dashed ? ' pl-dashed' : ''}${s.thin ? ' pl-thin' : ''}`}
          />
        ))}
        {p.markers?.map((m, i) => (
          <circle key={`m${i}`} cx={sx(m.x)} cy={sy(m.y)} r={m.r ?? 4} className={`pl-dot ${m.cls}`}>
            {m.label && <title>{m.label}</title>}
          </circle>
        ))}
      </g>
      {p.vlines?.map(
        (l) =>
          l.label && (
            <text key={`vl${l.at}`} x={sx(l.at) + 4} y={PAD.t + 12} className="pl-tick">
              {l.label}
            </text>
          ),
      )}
      {p.hlines?.map(
        (l) =>
          l.label && (
            <text key={`hl${l.at}`} x={W - PAD.r - 4} y={sy(l.at) - 4} textAnchor="end" className="pl-tick">
              {l.label}
            </text>
          ),
      )}
      {p.xLabel && (
        <text x={(PAD.l + W - PAD.r) / 2} y={H - 3} textAnchor="middle" className="pl-label">
          {p.xLabel}
        </text>
      )}
      {p.yLabel && (
        <text
          x={12}
          y={(PAD.t + H - PAD.b) / 2}
          textAnchor="middle"
          className="pl-label"
          transform={`rotate(-90 12 ${(PAD.t + H - PAD.b) / 2})`}
        >
          {p.yLabel}
        </text>
      )}
    </svg>
  );
}

/** A coloured key for a legend under a plot. */
export function Key({ cls, children, dashed }: { cls: string; children: string; dashed?: boolean }) {
  return (
    <span className="pl-key">
      <i className={`${cls}${dashed ? ' pl-dashed' : ''}`} />
      {children}
    </span>
  );
}
