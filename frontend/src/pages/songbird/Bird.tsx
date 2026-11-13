import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { Palette } from './songs';
import type { VoiceState } from './synth';

/**
 * An original, stylised songbird in cutaway, with the parts that make its song: the two sides of the syrinx where the
 * windpipe splits, the air sacs that power them, the windpipe, the throat chamber and the beak. update() moves the
 * parts every frame from what each side is singing, without re-rendering React.
 */

export interface BirdHandle {
  update: (s: { L: VoiceState; R: VoiceState; playing: boolean }, t: number, tubeMm: number) => void;
}

const SYRINX = { x: 384, y: 304 };
const khz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);

interface LabelProps {
  x: number;
  y: number;
  to: [number, number];
  title: string;
  sub: string;
  align: 'start' | 'end';
  subRef?: (el: SVGTextElement | null) => void;
}

function Label({ x, y, to, title, sub, align, subRef }: LabelProps) {
  const lineStart = align === 'start' ? x - 6 : x + 6;
  return (
    <g className="sb-label">
      <line x1={lineStart} y1={y - 4} x2={to[0]} y2={to[1]} />
      <circle cx={to[0]} cy={to[1]} r={2.2} />
      <text x={x} y={y - 6} textAnchor={align} className="sb-label-title">
        {title}
      </text>
      <text x={x} y={y + 8} textAnchor={align} className="sb-label-sub" ref={subRef}>
        {sub}
      </text>
    </g>
  );
}

export const Bird = forwardRef<BirdHandle, { palette: Palette }>(function Bird({ palette }, ref) {
  const jaw = useRef<SVGGElement>(null);
  const left = useRef<SVGEllipseElement>(null);
  const right = useRef<SVGEllipseElement>(null);
  const leftGlow = useRef<SVGCircleElement>(null);
  const rightGlow = useRef<SVGCircleElement>(null);
  const throat = useRef<SVGEllipseElement>(null);
  const chestSac = useRef<SVGEllipseElement>(null);
  const bellySacs = useRef<SVGGElement>(null);
  const airflow = useRef<SVGPathElement>(null);
  const subs = useRef<Record<string, SVGTextElement | null>>({});
  const sub = (key: string) => (el: SVGTextElement | null) => {
    subs.current[key] = el;
  };

  useImperativeHandle(ref, () => ({
    update(s, t, tubeMm) {
      const loud = Math.max(s.L.amp, s.R.amp);
      const top = Math.max(s.L.amp > 0 ? s.L.freq : 0, s.R.amp > 0 ? s.R.freq : 0);
      // The beak opens wider for higher notes, as real birds' beaks do.
      const gape = loud > 0 ? Math.min(20, 3 + (top / 8000) * 17) : 0;
      jaw.current?.setAttribute('transform', `rotate(${gape} 436 168)`);
      for (const [side, el, glow, f] of [
        ['L', left.current, leftGlow.current, s.L],
        ['R', right.current, rightGlow.current, s.R],
      ] as const) {
        const wobble = f.amp > 0 ? Math.sin(t * (f.freq / 40)) * 1.4 * f.amp : 0;
        el?.setAttribute('rx', String(5 + wobble));
        glow?.setAttribute('r', String(f.amp > 0 ? 10 + f.amp * 10 : 0));
        glow?.setAttribute('opacity', String(f.amp > 0 ? 0.25 + f.amp * 0.5 : 0));
        const label = subs.current[side];
        if (label) label.textContent = f.amp > 0 ? `Singing · ${khz(f.freq)}` : 'Quiet';
      }
      // The throat chamber swells to tune itself to the note.
      const swell = loud > 0 ? 1 + Math.min(1, top / 7000) * 0.9 : 1;
      throat.current?.setAttribute('ry', String(7 * swell));
      throat.current?.setAttribute('rx', String(11 * swell));
      if (subs.current.throat) subs.current.throat.textContent = loud > 0 ? `Tuned to ${khz(top)}` : 'Relaxed';
      // Air sacs: squeezed while singing, refilled in the gaps (mini-breaths).
      const breath = s.playing ? 1 - loud * 0.12 : 1 + Math.sin(t * 2.2) * 0.04;
      chestSac.current?.setAttribute('transform', `translate(${SYRINX.x} ${SYRINX.y + 4}) scale(${breath})`);
      bellySacs.current?.setAttribute('transform', `translate(312 318) scale(${breath})`);
      if (airflow.current) {
        airflow.current.style.opacity = loud > 0 ? '0.9' : '0';
        airflow.current.style.strokeDashoffset = String(-t * 160);
      }
      if (subs.current.tube) subs.current.tube.textContent = `Resonant tube (${tubeMm} × 3 mm)`;
      if (subs.current.beak) subs.current.beak.textContent = loud > 0 ? `Open ${gape.toFixed(0)}°` : 'Closed';
    },
  }));

  const tail = palette.tail ?? 1;
  return (
    <svg viewBox="0 0 680 470" className="sb-bird" role="img" aria-label="A songbird in cutaway, showing its syrinx">
      <defs>
        <radialGradient id="sb-glow-l">
          <stop offset="0" stopColor="#4466c7" />
          <stop offset="1" stopColor="#4466c7" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="sb-glow-r">
          <stop offset="0" stopColor="#e07b2d" />
          <stop offset="1" stopColor="#e07b2d" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* The branch and leaves. */}
      <path d="M70 418 C 200 404, 420 400, 640 392" className="sb-branch" />
      <path d="M560 396 C 585 370, 620 372, 630 386 C 610 398, 585 402, 560 396 Z" className="sb-leaf" />
      <path d="M120 414 C 110 388, 132 370, 150 376 C 150 396, 140 410, 120 414 Z" className="sb-leaf" />

      {/* Tail, body, belly, wing. */}
      <path
        d={`M200 338 L ${200 - 125 * tail} ${372 + 20 * tail} L ${206 - 118 * tail} ${392 + 22 * tail} L 214 352 Z`}
        fill={palette.wing}
      />
      <path
        d="M178 334 C 192 250, 272 190, 362 185 C 402 183, 424 212, 418 252 C 412 322, 362 372, 292 377 C 242 380, 202 362, 178 334 Z"
        fill={palette.body}
      />
      <ellipse cx={340} cy={308} rx={62} ry={62} fill={palette.belly} opacity={0.85} />
      <path d="M226 262 C 276 222, 352 228, 366 268 C 348 300, 280 330, 196 342 Z" fill={palette.wing} />
      <path d="M240 280 C 280 268, 320 270, 345 282 M232 300 C 270 292, 310 296, 330 304" className="sb-feather" />

      {/* Legs and feet. */}
      <path d="M318 372 L 312 404 M346 368 L 352 402 M300 404 L 326 404 M338 402 L 364 402" className="sb-leg" />

      {/* Head, crest, mask, eye. */}
      {palette.crest && <path d="M372 132 L 350 74 L 404 124 Z" fill={palette.body} />}
      <circle cx={396} cy={166} r={48} fill={palette.body} />
      {palette.mask && (
        <path d="M420 136 C 446 140, 452 190, 424 194 C 406 182, 406 148, 420 136 Z" fill={palette.mask} />
      )}
      <circle cx={412} cy={156} r={6.5} fill="#151515" />
      <circle cx={414} cy={154} r={2} fill="#fff" />

      {/* Beak: the lower half hinges open. */}
      <path d="M434 148 L 492 163 L 434 170 Z" fill={palette.beak} />
      <g ref={jaw}>
        <path d="M434 168 L 486 166 L 434 181 Z" fill={palette.beak} style={{ filter: 'brightness(0.88)' }} />
      </g>

      {/* The cutaway. */}
      <path
        d="M402 198 C 436 206, 438 252, 420 300 C 408 338, 372 352, 348 338 C 330 318, 342 272, 362 236 C 374 214, 388 200, 402 198 Z"
        className="sb-cut"
      />
      {/* Belly air sacs (breath). */}
      <g ref={bellySacs} transform="translate(312 318)">
        <ellipse cx={-22} cy={0} rx={26} ry={18} className="sb-sac" />
        <ellipse cx={14} cy={10} rx={22} ry={15} className="sb-sac" />
      </g>
      {/* Chest air cushion around the syrinx. */}
      <ellipse
        ref={chestSac}
        cx={0}
        cy={0}
        rx={30}
        ry={20}
        className="sb-sac chest"
        transform={`translate(${SYRINX.x} ${SYRINX.y + 4})`}
      />
      {/* Windpipe from the throat down to the syrinx, with its rings, and the air moving through it. */}
      <path d={`M430 180 C 424 220, 398 250, ${SYRINX.x} ${SYRINX.y - 6}`} className="sb-trachea" />
      <path d={`M430 180 C 424 220, 398 250, ${SYRINX.x} ${SYRINX.y - 6}`} className="sb-rings" />
      <path ref={airflow} d={`M${SYRINX.x} ${SYRINX.y - 6} C 398 250, 424 220, 430 180`} className="sb-air" />
      {/* Throat chamber. */}
      <ellipse ref={throat} cx={430} cy={192} rx={11} ry={7} className="sb-throat" />
      {/* The syrinx: two bronchi meeting, a side each, and the splitter between. */}
      <path
        d={`M${SYRINX.x} ${SYRINX.y} L ${SYRINX.x - 20} ${SYRINX.y + 34} M${SYRINX.x} ${SYRINX.y} L ${SYRINX.x + 20} ${SYRINX.y + 34}`}
        className="sb-bronchi"
      />
      <circle ref={leftGlow} cx={SYRINX.x - 9} cy={SYRINX.y + 6} r={0} fill="url(#sb-glow-l)" />
      <circle ref={rightGlow} cx={SYRINX.x + 9} cy={SYRINX.y + 6} r={0} fill="url(#sb-glow-r)" />
      <ellipse ref={left} cx={SYRINX.x - 8} cy={SYRINX.y + 6} rx={5} ry={8} className="sb-fold left" />
      <ellipse ref={right} cx={SYRINX.x + 8} cy={SYRINX.y + 6} rx={5} ry={8} className="sb-fold right" />
      <path
        d={`M${SYRINX.x - 3} ${SYRINX.y - 2} L ${SYRINX.x + 3} ${SYRINX.y - 2} L ${SYRINX.x} ${SYRINX.y + 12} Z`}
        className="sb-splitter"
      />

      {/* Labels. */}
      <Label x={540} y={150} to={[488, 163]} title="Beak" sub="Closed" align="start" subRef={sub('beak')} />
      <Label
        x={540}
        y={198}
        to={[440, 192]}
        title="Throat chamber"
        sub="Relaxed"
        align="start"
        subRef={sub('throat')}
      />
      <Label x={540} y={246} to={[410, 240]} title="Windpipe" sub="Resonant tube" align="start" subRef={sub('tube')} />
      <Label
        x={540}
        y={294}
        to={[SYRINX.x + 12, SYRINX.y + 6]}
        title="Right voice (high notes)"
        sub="Quiet"
        align="start"
        subRef={sub('R')}
      />
      <Label x={540} y={342} to={[330, 330]} title="Belly air sacs (breath)" sub="Push air to sing" align="start" />
      <Label
        x={150}
        y={190}
        to={[SYRINX.x, SYRINX.y]}
        title="Centre splitter"
        sub="Divides the two airways"
        align="end"
      />
      <Label
        x={150}
        y={240}
        to={[SYRINX.x - 12, SYRINX.y + 6]}
        title="Left voice (low notes)"
        sub="Quiet"
        align="end"
        subRef={sub('L')}
      />
      <Label
        x={150}
        y={290}
        to={[SYRINX.x - 26, SYRINX.y + 14]}
        title="Chest air cushion"
        sub="Presses on the syrinx"
        align="end"
      />
    </svg>
  );
});
