import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { tidy, type Pt } from './tidy';

/* The drawing board: strokes from a mouse, pen or finger, kept as lists of points so undo can redraw the rest. With
   tidying on, each finished stroke that is clearly a line, circle, ellipse, triangle, rectangle or polygon is redrawn
   exactly (tidy.ts); handwriting is left alone. The board's picture goes to the model as a PNG, at most 1,024 pixels
   wide. */

export interface Stroke {
  points: Pt[];
  colour: string;
  width: number;
  erase: boolean;
  /** The stroke as drawn, kept when it was tidied so "Keep as drawn" can put it back. */
  raw?: Pt[];
  shape?: string;
}

export interface BoardHandle {
  /** The board as a base64 PNG (no data: prefix), or null when it is empty. */
  snapshot(): string | null;
  /** A small JPEG data URL of the board, for the history list. */
  thumbnail(): string;
  isEmpty(): boolean;
  /** A copy of the strokes, to keep with a reading in the history. */
  strokes(): Stroke[];
  /** Puts saved strokes back on the board. */
  load(strokes: Stroke[]): void;
}

const COLOURS = ['#f8fafc', '#fbbf24', '#38bdf8', '#f87171'];
const BACKGROUND = '#1f2937';

function draw(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.colour;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.1, s.points[0][1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

export const Board = forwardRef<BoardHandle>(function Board(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [colour, setColour] = useState(COLOURS[0]);
  const [erase, setErase] = useState(false);
  const [count, setCount] = useState(0); // strokes, so the buttons know when there is something to undo
  const [tidyOn, setTidyOn] = useState(true);
  const [tidied, setTidied] = useState<string | null>(null); // what the last stroke was taken for

  const redraw = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, strokes.current, c.width / dpr, c.height / dpr);
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = c.getBoundingClientRect();
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      redraw();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(c);
    return () => observer.disconnect();
  }, []);

  // The board drawn onto a fresh canvas, on the board colour, at most maxWidth wide.
  const render = (maxWidth: number): HTMLCanvasElement | null => {
    const c = canvas.current;
    if (!c) return null;
    const { width, height } = c.getBoundingClientRect();
    const k = Math.min(1, maxWidth / width);
    const out = document.createElement('canvas');
    out.width = Math.round(width * k);
    out.height = Math.round(height * k);
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const layer = document.createElement('canvas'); // strokes (and erasing) on their own layer, then onto the board colour
    layer.width = out.width;
    layer.height = out.height;
    const lctx = layer.getContext('2d');
    if (!lctx) return null;
    lctx.scale(k, k);
    draw(lctx, strokes.current, width, height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(layer, 0, 0);
    return out;
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokes.current.every((s) => s.erase),
    snapshot() {
      if (strokes.current.every((s) => s.erase)) return null;
      return render(1024)?.toDataURL('image/png').split(',')[1] ?? null;
    },
    thumbnail: () => render(240)?.toDataURL('image/jpeg', 0.7) ?? '',
    strokes: () => strokes.current.map((s) => ({ ...s, points: s.points.slice() })),
    load(saved) {
      strokes.current = saved.map((s) => ({ ...s, points: s.points.slice() }));
      setCount(strokes.current.length);
      setTidied(null);
      redraw();
    },
  }));

  const at = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  return (
    <div className="wb-board">
      <canvas
        ref={canvas}
        className="wb-canvas"
        aria-label="Drawing board"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          current.current = { points: [at(e)], colour, width: erase ? 28 : 4, erase };
          strokes.current.push(current.current);
          redraw();
        }}
        onPointerMove={(e) => {
          if (!current.current) return;
          current.current.points.push(at(e));
          redraw();
        }}
        onPointerUp={() => {
          const s = current.current;
          current.current = null;
          if (s && !s.erase && tidyOn) {
            const t = tidy(s.points);
            if (t.shape) {
              s.raw = s.points;
              s.shape = t.shape;
            }
            s.points = t.points;
            redraw();
          }
          setTidied(s?.shape ?? null);
          setCount(strokes.current.length);
        }}
        onPointerCancel={() => {
          current.current = null;
        }}
      />
      {tidied && (
        <div className="wb-tidied small">
          Tidied into a {tidied}
          <button
            className="btn small"
            onClick={() => {
              const last = strokes.current[strokes.current.length - 1];
              if (last?.raw) {
                last.points = last.raw;
                delete last.raw;
                delete last.shape;
              }
              setTidied(null);
              redraw();
            }}
          >
            Keep as drawn
          </button>
        </div>
      )}
      {count === 0 && (
        <p className="wb-hint">Draw here: a graph, an equation such as y = x² − 3, or a shape such as a box</p>
      )}
      <div className="wb-tools" role="toolbar" aria-label="Drawing tools">
        {COLOURS.map((c) => (
          <button
            key={c}
            className={`wb-swatch${!erase && colour === c ? ' on' : ''}`}
            style={{ background: c }}
            onClick={() => {
              setColour(c);
              setErase(false);
            }}
            aria-label={`Pen colour ${c}`}
          />
        ))}
        <button className={`btn small${erase ? ' primary' : ''}`} onClick={() => setErase((v) => !v)}>
          Eraser
        </button>
        <button
          className={`btn small${tidyOn ? ' primary' : ''}`}
          onClick={() => setTidyOn((v) => !v)}
          title="Redraw lines, circles and polygons exactly as you finish them"
        >
          {tidyOn ? '✓ Tidy shapes' : 'Tidy shapes'}
        </button>
        <button
          className="btn small"
          disabled={count === 0}
          onClick={() => {
            strokes.current.pop();
            setTidied(null);
            setCount(strokes.current.length);
            redraw();
          }}
        >
          Undo
        </button>
        <button
          className="btn small"
          disabled={count === 0}
          onClick={() => {
            strokes.current = [];
            setTidied(null);
            setCount(0);
            redraw();
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
});
