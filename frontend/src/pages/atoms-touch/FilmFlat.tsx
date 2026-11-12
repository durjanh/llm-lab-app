import { useEffect, useRef } from 'react';
import {
  BEAD_RADIUS,
  CELL_THICK,
  CELL_WIDTH,
  CHAIN_BEADS,
  CHAIN_SPACING,
  CHAIN_STEP,
  CLOUD_RADIUS,
  FINGER_RADIUS,
  LAYERS,
  RIDGE_DEPTH,
  RIDGE_PERIOD,
  VIEW_HEIGHT,
  layerOpacity,
  type FilmState,
  type Layer,
} from './film';

/* The film as a flat cross-section, for browsers without WebGL and for anyone who prefers a diagram. It is drawn from
   the same film state and the same sizes as the 3D scene: a slice through both fingers, seen from the side. */

interface Palette {
  fill: string;
  dark: string;
  light: string;
}
const TOP: Palette = { fill: '#f0b27c', dark: '#6e4526', light: '255,206,150' };
const BOTTOM: Palette = { fill: '#74b9dc', dark: '#234a63', light: '150,215,255' };

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** The inputs a layer is drawn from: half the picture's width and its height in the layer's own unit, and the scale. */
interface View {
  ctx: CanvasRenderingContext2D;
  half: number;
  far: number;
  px: number; // pixels per layer unit
  pal: Palette;
  state: FilmState;
}

/** Fills the finger's body under a surface line y(x), with the body towards +y. */
function body({ ctx, half, far, pal }: View, y: (x: number) => number, step: number, colour = pal.fill) {
  const dx = Math.max(step, (2 * half) / 1500);
  ctx.beginPath();
  ctx.moveTo(-half, far);
  for (let x = -half; x <= half + dx; x += dx) ctx.lineTo(x, Math.min(far, y(x)));
  ctx.lineTo(half, far);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

const ridge = (x: number) => (RIDGE_DEPTH / 2) * (1 - Math.cos((2 * Math.PI * x) / RIDGE_PERIOD));
const round = (x: number) =>
  Math.abs(x) < FINGER_RADIUS ? FINGER_RADIUS - Math.sqrt(FINGER_RADIUS ** 2 - x * x) : Number.POSITIVE_INFINITY;

const DRAW: Record<Layer['id'], (v: View) => void> = {
  dome: (v) => body(v, round, 0.05),
  ridges: (v) => body(v, (x) => round(x) + ridge(x), RIDGE_PERIOD / 14),
  cells(v) {
    const { ctx, half, far, px, pal } = v;
    body(v, () => 0, half, pal.dark); // what holds the cells together
    const pitch = CELL_THICK + 0.12;
    const rows = Math.min(160, Math.ceil(far / pitch));
    ctx.fillStyle = pal.fill;
    for (let row = 0; row < rows; row++) {
      if (row > 0 && px * CELL_THICK < 0.5) break; // too thin to see
      const shift = row === 0 ? -CELL_WIDTH / 2 : hash(row) * CELL_WIDTH; // the middle cell of the top row touches
      const first = Math.floor((-half - shift) / CELL_WIDTH) - 1;
      const count = Math.min(80, Math.ceil((2 * half) / CELL_WIDTH) + 3);
      ctx.globalAlpha *= row % 2 ? 0.86 : 1;
      for (let i = first; i < first + count; i++) {
        ctx.fillRect(shift + i * CELL_WIDTH + 0.3, row * pitch, CELL_WIDTH - 0.6, CELL_THICK);
      }
      ctx.globalAlpha /= row % 2 ? 0.86 : 1;
    }
  },
  envelope: (v) =>
    body(v, (x) => 1.5 * (1 - Math.cos((2 * Math.PI * x) / 25)) + 0.8 * (1 - Math.cos((2 * Math.PI * x) / 9.3)), 0.6),
  grain: (v) => body(v, (x) => 0.1 * (1 - Math.cos((2 * Math.PI * x) / CHAIN_SPACING)), CHAIN_SPACING / 8),
  chains(v) {
    const { ctx, half, pal } = v;
    body(v, () => CHAIN_BEADS * CHAIN_STEP, half, pal.dark);
    const n = Math.min(60, Math.ceil(half / CHAIN_SPACING) + 1);
    ctx.fillStyle = pal.fill;
    ctx.strokeStyle = pal.dark;
    ctx.lineWidth = 0.014;
    for (let i = -n; i <= n; i++) {
      const inner = Math.abs(i) <= 2;
      const recess = inner ? 0 : hash(i + 40) * 0.07;
      const lean = inner ? 0 : (hash(i + 400) - 0.5) * 0.2;
      for (let j = CHAIN_BEADS - 1; j >= 0; j--) {
        const up = j * CHAIN_STEP;
        ctx.beginPath();
        ctx.arc(i * CHAIN_SPACING + (j % 2 ? 1 : -1) * 0.04 + lean * up, recess + up, BEAD_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  },
  atoms({ ctx, pal, state }) {
    for (let i = -2; i <= 2; i++) {
      for (let j = 1; j >= 0; j--) {
        const x = i * CHAIN_SPACING + (j % 2 ? 1 : -1) * 0.04;
        const y = j * CHAIN_STEP;
        // The atoms that face the other finger are squeezed, the middle one most; their far edge stays put.
        const squeeze = j === 0 ? 0.28 * state.press * (i === 0 ? 1 : 0.7) : 0;
        ctx.save();
        ctx.translate(x, y + CLOUD_RADIUS);
        ctx.scale(1, 1 - squeeze);
        const cloud = ctx.createRadialGradient(0, -CLOUD_RADIUS, 0, 0, -CLOUD_RADIUS, CLOUD_RADIUS);
        cloud.addColorStop(0, `rgba(${pal.light},0.75)`);
        cloud.addColorStop(0.6, `rgba(${pal.light},0.4)`);
        cloud.addColorStop(1, `rgba(${pal.light},0)`);
        ctx.fillStyle = cloud;
        ctx.beginPath();
        ctx.arc(0, -CLOUD_RADIUS, CLOUD_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff6d5';
        ctx.beginPath();
        ctx.arc(0, -CLOUD_RADIUS, 0.008, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  },
};

/** Draws one frame of the film on a canvas `width` by `height` CSS pixels. */
export function drawFlat(ctx: CanvasRenderingContext2D, width: number, height: number, state: FilmState) {
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, width, height);
  const scale = height / (VIEW_HEIGHT * state.pull); // pixels per scene unit
  const atomsShown = layerOpacity(LAYERS[LAYERS.length - 1], state.unit);

  for (const [sign, pal] of [
    [1, TOP],
    [-1, BOTTOM],
  ] as const) {
    for (const layer of LAYERS) {
      const opacity = layerOpacity(layer, state.unit) * (layer.id === 'chains' ? 1 - 0.7 * atomsShown : 1);
      if (opacity < 0.01) continue;
      const px = (scale * layer.natural) / state.unit;
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(width / 2, height / 2 - (sign * state.sceneGap * scale) / 2);
      ctx.scale(px, -sign * px); // +y now points into this finger, away from the gap
      DRAW[layer.id]({ ctx, half: width / 2 / px, far: height / px, px, pal, state });
      ctx.restore();
    }
  }

  // Where the clouds are squeezed together the push shows as light.
  const pushing = Math.max(0, Math.min(1, state.force / 3e-11)) * atomsShown;
  if (pushing > 0.01) {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(scale * 0.7, scale * (0.1 + 0.08 * pushing));
    const flare = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    flare.addColorStop(0, `rgba(255,255,255,${0.9 * pushing})`);
    flare.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = flare;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The gap being measured.
  const reach = (state.sceneGap * scale) / 2;
  ctx.strokeStyle = `rgba(255,255,255,${0.75 - 0.4 * atomsShown})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(width / 2, height / 2 - reach);
  ctx.lineTo(width / 2, height / 2 + reach);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const y of [-reach, reach]) {
    ctx.moveTo(width / 2 - 7, height / 2 + y);
    ctx.lineTo(width / 2 + 7, height / 2 + y);
  }
  ctx.stroke();
}

/** The film as a flat cross-section on a 2D canvas. */
export function FilmFlat({ state }: { state: FilmState }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(state);
  latest.current = state;

  const paint = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFlat(ctx, c.width / dpr, c.height / dpr, latest.current);
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = c.getBoundingClientRect();
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      paint();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(c);
    return () => observer.disconnect();
  }, []);

  useEffect(paint, [state]);

  return <canvas ref={canvas} className="at-picture" role="img" aria-label="The film, drawn as a flat cross-section" />;
}
