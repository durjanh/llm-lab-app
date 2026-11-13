import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { tidy, type Pt } from './tidy';

/* The drawing board: strokes from a mouse, pen or finger, kept as lists of points so undo can redraw the rest. Tools:
   a pen, a highlighter, an eraser and four shapes (line, rectangle, ellipse, arrow), in eight colours and three sizes.
   With tidying on, each finished pen stroke that is clearly a line, circle, ellipse, triangle, rectangle or polygon is
   redrawn exactly (tidy.ts); handwriting is left alone. Freehand strokes are smoothed as they are drawn, and a
   stylus's pressure sets their width. The board's picture goes to the model as a PNG, at most 1,024 pixels wide. */

export interface Stroke {
  points: Pt[];
  colour: string;
  width: number;
  erase: boolean;
  /** The stroke as drawn, kept when it was tidied so "Keep as drawn" can put it back. */
  raw?: Pt[];
  /** What the stroke is, when it is an exact shape: from tidying, or drawn with a shape tool. */
  shape?: string;
  /** Less than 1 for the highlighter. Boards saved before it existed have none, and draw solid. */
  alpha?: number;
}

/** A recognised shape on the board, for a model that needs coordinates as well as a picture. */
export interface ShapeHint {
  shape: string;
  /** Left, top, right, bottom, in board units (CSS pixels from the board's top-left corner). */
  box: [number, number, number, number];
  from?: Pt;
  to?: Pt;
}

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'line' | 'rectangle' | 'ellipse' | 'arrow';

export interface BoardHandle {
  /** The board as a base64 PNG (no data: prefix) at most maxWidth wide, or null when it is empty. */
  snapshot(maxWidth?: number): string | null;
  /** A small JPEG data URL of the board, for the history list. */
  thumbnail(): string;
  isEmpty(): boolean;
  /** A copy of the strokes, to keep with a reading in the history. */
  strokes(): Stroke[];
  /** Puts saved strokes back on the board. */
  load(strokes: Stroke[]): void;
  /** The exact shapes on the board, with where they are. */
  shapes(): ShapeHint[];
  /** The board's size in its own units. */
  size(): { width: number; height: number };
  /** A number that goes up whenever the drawing changes. */
  version(): number;
}

const COLOURS = ['#f8fafc', '#fbbf24', '#fb923c', '#f87171', '#f472b6', '#a78bfa', '#38bdf8', '#4ade80'];
const SIZES = [2, 4, 8];
const BACKGROUND = '#1f2937';
const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'pen', label: '✎ Pen', title: 'Draw freehand' },
  { id: 'highlighter', label: '▍Highlight', title: 'A wide, see-through stroke' },
  { id: 'line', label: '╱ Line', title: 'Drag out a straight line' },
  { id: 'arrow', label: '→ Arrow', title: 'Drag out an arrow' },
  { id: 'rectangle', label: '▭ Box', title: 'Drag out a rectangle' },
  { id: 'ellipse', label: '◯ Ellipse', title: 'Drag out an ellipse' },
  { id: 'eraser', label: '⌫ Eraser', title: 'Rub out' },
];

/** The outline of a shape tool's shape between where the drag began and where it is now. */
function shapePoints(tool: Tool, a: Pt, b: Pt): Pt[] {
  if (tool === 'rectangle') return [a, [b[0], a[1]], b, [a[0], b[1]], a];
  if (tool === 'ellipse') {
    const [cx, cy, rx, ry] = [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      Math.abs(b[0] - a[0]) / 2,
      Math.abs(b[1] - a[1]) / 2,
    ];
    return Array.from({ length: 49 }, (_, i): Pt => {
      const t = (i / 48) * 2 * Math.PI;
      return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    });
  }
  if (tool === 'arrow') {
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const head = Math.min(18, Math.hypot(b[0] - a[0], b[1] - a[1]) / 3);
    const barb = (turn: number): Pt => [b[0] - head * Math.cos(angle + turn), b[1] - head * Math.sin(angle + turn)];
    return [a, b, barb(0.45), b, barb(-0.45)];
  }
  return [a, b];
}

function draw(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  for (const s of strokes) {
    const p = s.points;
    if (p.length === 0) continue;
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.globalAlpha = s.erase ? 1 : (s.alpha ?? 1);
    ctx.strokeStyle = s.colour;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    if (s.shape || p.length < 3) {
      for (const [x, y] of p.slice(1)) ctx.lineTo(x, y);
    } else {
      // Freehand: curve through the midpoints, so the corners between samples are rounded off.
      for (let i = 1; i < p.length - 1; i++)
        ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    }
    if (p.length === 1) ctx.lineTo(p[0][0] + 0.1, p[0][1]);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

interface BoardProps {
  /** Offer shape tidying (on by default). Off where the drawing itself is what is being looked at. */
  tidy?: boolean;
  /** The words shown on an empty board. */
  hint?: string;
  /** Called after the drawing changes: a finished stroke, an undo, a clear or a load. */
  onChange?: () => void;
  /** Fades the drawing and stops new strokes, while something drawn over it (children) has the board. */
  covered?: boolean;
  /** Drawn over the canvas, inside the board. */
  children?: ReactNode;
}

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(
  { tidy: canTidy = true, hint, onChange, covered = false, children },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const undone = useRef<Stroke[]>([]); // strokes taken back, for redo
  const cleared = useRef<Stroke[] | null>(null); // the board before the last Clear, so undo can bring it back
  const current = useRef<{ stroke: Stroke; start: Pt; pressure: number[] } | null>(null);
  const versionRef = useRef(0);
  const changed = useRef(onChange);
  changed.current = onChange;
  const [tool, setTool] = useState<Tool>('pen');
  const [colour, setColour] = useState(COLOURS[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [grid, setGrid] = useState(false);
  const [counts, setCounts] = useState({ strokes: 0, redo: 0, cleared: false });
  const [tidyOn, setTidyOn] = useState(canTidy);
  const [tidied, setTidied] = useState<string | null>(null); // what the last stroke was taken for

  const redraw = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, strokes.current, c.width / dpr, c.height / dpr);
  };

  /** After any change to the strokes: redraw, refresh the buttons and tell the page. */
  const commit = (note: string | null = null) => {
    versionRef.current += 1;
    setTidied(note);
    setCounts({ strokes: strokes.current.length, redo: undone.current.length, cleared: !!cleared.current });
    redraw();
    changed.current?.();
  };

  const undo = () => {
    if (strokes.current.length === 0 && cleared.current) {
      strokes.current = cleared.current;
      cleared.current = null;
    } else {
      const last = strokes.current.pop();
      if (!last) return;
      undone.current.push(last);
    }
    commit();
  };
  const redo = () => {
    const back = undone.current.pop();
    if (!back) return;
    strokes.current.push(back);
    commit();
  };
  const actions = useRef({ undo, redo });
  actions.current = { undo, redo };

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
    // Cmd or Ctrl+Z undoes and with Shift redoes, unless the person is typing somewhere.
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      )
        return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) actions.current.redo();
      else actions.current.undo();
    };
    window.addEventListener('keydown', key);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', key);
    };
  }, []);

  // The board drawn onto a fresh canvas, on the board colour, at most maxWidth wide.
  const render = (maxWidth: number): HTMLCanvasElement | null => {
    const c = canvas.current;
    if (!c) return null;
    const { width, height } = c.getBoundingClientRect();
    const k = Math.min(maxWidth / width, 3);
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

  const boardSize = () => {
    const r = canvas.current?.getBoundingClientRect();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokes.current.every((s) => s.erase),
    snapshot(maxWidth = 1024) {
      if (strokes.current.every((s) => s.erase)) return null;
      return (
        render(Math.min(maxWidth, boardSize().width || maxWidth))
          ?.toDataURL('image/png')
          .split(',')[1] ?? null
      );
    },
    thumbnail: () => render(240)?.toDataURL('image/jpeg', 0.7) ?? '',
    strokes: () => strokes.current.map((s) => ({ ...s, points: s.points.slice() })),
    load(saved) {
      strokes.current = saved.map((s) => ({ ...s, points: s.points.slice() }));
      undone.current = [];
      cleared.current = null;
      commit();
    },
    shapes: () =>
      strokes.current
        .filter((s) => s.shape && !s.erase && s.points.length > 1)
        .map((s) => {
          const xs = s.points.map((p) => p[0]);
          const ys = s.points.map((p) => p[1]);
          const round = (v: number) => Math.round(v);
          const hint: ShapeHint = {
            shape: s.shape!,
            box: [round(Math.min(...xs)), round(Math.min(...ys)), round(Math.max(...xs)), round(Math.max(...ys))],
          };
          if (s.shape === 'line' || s.shape === 'arrow') {
            const end = s.shape === 'arrow' ? s.points[1] : s.points[s.points.length - 1];
            hint.from = [round(s.points[0][0]), round(s.points[0][1])];
            hint.to = [round(end[0]), round(end[1])];
          }
          return hint;
        }),
    size: boardSize,
    version: () => versionRef.current,
  }));

  const at = (e: { clientX: number; clientY: number }, target: Element): Pt => {
    const r = target.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const isShape = tool === 'line' || tool === 'rectangle' || tool === 'ellipse' || tool === 'arrow';
  const savePng = () => {
    const out = render(2000);
    if (!out) return;
    const link = document.createElement('a');
    link.download = 'whiteboard.png';
    link.href = out.toDataURL('image/png');
    link.click();
  };

  return (
    <div className={`wb-board${grid ? ' grid' : ''}${covered ? ' covered' : ''}`}>
      <canvas
        ref={canvas}
        className="wb-canvas"
        aria-label="Drawing board"
        onPointerDown={(e) => {
          if (covered) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const start = at(e, e.currentTarget);
          const stroke: Stroke =
            tool === 'eraser'
              ? { points: [start], colour, width: size * 7, erase: true }
              : tool === 'highlighter'
                ? { points: [start], colour, width: size * 5, erase: false, alpha: 0.35 }
                : { points: [start], colour, width: size, erase: false, ...(isShape ? { shape: tool } : {}) };
          current.current = { stroke, start, pressure: [] };
          strokes.current.push(stroke);
          undone.current = [];
          cleared.current = null;
          redraw();
        }}
        onPointerMove={(e) => {
          const c = current.current;
          if (!c) return;
          const target = e.currentTarget;
          if (isShape) {
            c.stroke.points = shapePoints(tool, c.start, at(e, target));
          } else {
            // Every sample the device took since the last frame, each pulled part-way towards the one before it:
            // that takes the jitter out of a hand-drawn line without it lagging behind the pen.
            const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
            for (const sample of events.length ? events : [e.nativeEvent]) {
              const [x, y] = at(sample, target);
              const [px, py] = c.stroke.points[c.stroke.points.length - 1];
              if (Math.hypot(x - px, y - py) < 1.5) continue;
              c.stroke.points.push(c.stroke.erase ? [x, y] : [px + (x - px) * 0.65, py + (y - py) * 0.65]);
              if (sample.pointerType === 'pen' && sample.pressure > 0) c.pressure.push(sample.pressure);
            }
          }
          redraw();
        }}
        onPointerUp={() => {
          const c = current.current;
          current.current = null;
          if (!c) return;
          const s = c.stroke;
          if (
            isShape &&
            Math.hypot(s.points[1]?.[0] - c.start[0], s.points[1]?.[1] - c.start[1]) < 4 &&
            s.points.length <= 5
          ) {
            const far = s.points.some((p) => Math.hypot(p[0] - c.start[0], p[1] - c.start[1]) > 4);
            if (!far) strokes.current.pop(); // a click, not a drag: no shape
          }
          if (c.pressure.length > 3 && !s.erase) {
            // A stylus: press harder for a thicker line.
            const mean = c.pressure.reduce((a, b) => a + b, 0) / c.pressure.length;
            s.width = Math.max(1, s.width * (0.5 + mean));
          }
          let note: string | null = null;
          if (tool === 'pen' && tidyOn) {
            const t = tidy(s.points);
            if (t.shape) {
              s.raw = s.points;
              s.shape = t.shape;
              note = t.shape;
            }
            s.points = t.points;
          }
          commit(note);
        }}
        onPointerCancel={() => {
          if (current.current) strokes.current.pop();
          current.current = null;
          redraw();
        }}
      />
      {children}
      {tidied && !covered && (
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
              commit();
            }}
          >
            Keep as drawn
          </button>
        </div>
      )}
      {counts.strokes === 0 && !covered && (
        <p className="wb-hint">
          {hint ?? 'Draw here: a graph, an equation such as y = x² − 3, or a shape such as a box'}
        </p>
      )}
      <div className="wb-tools" role="toolbar" aria-label="Drawing tools">
        <div className="wb-tool-row">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`btn small${tool === t.id ? ' primary' : ''}`}
              title={t.title}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="wb-tool-row">
          {COLOURS.map((c) => (
            <button
              key={c}
              className={`wb-swatch${colour === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => {
                setColour(c);
                if (tool === 'eraser') setTool('pen');
              }}
              aria-label={`Colour ${c}`}
            />
          ))}
          <span className="wb-sizes" role="group" aria-label="Line width">
            {SIZES.map((s) => (
              <button
                key={s}
                className={`wb-size${size === s ? ' on' : ''}`}
                onClick={() => setSize(s)}
                aria-label={`Width ${s}`}
              >
                <i style={{ width: s * 2 + 2, height: s * 2 + 2 }} />
              </button>
            ))}
          </span>
          {canTidy && (
            <button
              className={`btn small${tidyOn ? ' primary' : ''}`}
              onClick={() => setTidyOn((v) => !v)}
              title="Redraw pen strokes that are lines, circles and polygons exactly as you finish them"
            >
              {tidyOn ? '✓ Tidy shapes' : 'Tidy shapes'}
            </button>
          )}
          <button className={`btn small${grid ? ' primary' : ''}`} onClick={() => setGrid((v) => !v)}>
            # Grid
          </button>
          <button
            className="btn small"
            disabled={counts.strokes === 0 && !counts.cleared}
            onClick={undo}
            title="Undo (Ctrl or ⌘ + Z)"
          >
            ↶ Undo
          </button>
          <button
            className="btn small"
            disabled={counts.redo === 0}
            onClick={redo}
            title="Redo (Shift + Ctrl or ⌘ + Z)"
          >
            ↷ Redo
          </button>
          <button
            className="btn small"
            disabled={counts.strokes === 0}
            onClick={() => {
              cleared.current = strokes.current;
              strokes.current = [];
              undone.current = [];
              commit();
            }}
          >
            Clear
          </button>
          <button
            className="btn small"
            disabled={counts.strokes === 0}
            onClick={savePng}
            title="Download the board as a PNG"
          >
            ⤓ PNG
          </button>
        </div>
      </div>
    </div>
  );
});
