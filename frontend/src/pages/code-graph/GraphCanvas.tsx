import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { CodeGraph, EdgeKind, GraphEdge, GraphNode, NodeKind } from '@/services/codeGraphService';

/* The graph, drawn on a canvas and laid out by a small force simulation written here: nodes push each other apart
   (checked only against neighbours in a grid, so thousands of nodes stay quick), edges pull like springs, and a weak
   pull to the middle keeps it together. Wheel to zoom, drag the background to pan, drag a node to move it, click to
   select. */

export const KIND_COLOUR: Record<NodeKind, string> = {
  folder: '#94a3b8',
  file: '#60a5fa',
  class: '#f59e0b',
  interface: '#a78bfa',
  function: '#34d399',
  method: '#f472b6',
};
export const EDGE_COLOUR: Record<EdgeKind, string> = {
  contains: 'rgba(148,163,184,0.16)',
  imports: 'rgba(96,165,250,0.40)',
  calls: 'rgba(245,158,11,0.32)',
  extends: 'rgba(167,139,250,0.75)',
};
const RADIUS: Record<NodeKind, number> = { folder: 5, file: 4.5, class: 4, interface: 3.5, function: 2.6, method: 2.2 };
const SPRING: Record<EdgeKind, [number, number]> = {
  contains: [26, 0.06], // [rest length, strength]
  imports: [110, 0.008],
  calls: [80, 0.006],
  extends: [60, 0.02],
};
const CELL = 70;

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
}

export interface GraphCanvasHandle {
  centreOn(id: string): void;
  fit(): void;
}

interface Props {
  graph: CodeGraph;
  kinds: Set<NodeKind>;
  edgeKinds: Set<EdgeKind>;
  focus: string | null;
  depth: number | null;
  lit: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The nodes to show: the chosen kinds, then only those within depth steps of the focus, plus anything lit. */
function visibleSet(
  graph: CodeGraph,
  kinds: Set<NodeKind>,
  edgeKinds: Set<EdgeKind>,
  focus: string | null,
  depth: number | null,
  lit: Set<string>,
): Set<string> {
  const byKind = new Set(graph.nodes.filter((n) => kinds.has(n.kind)).map((n) => n.id));
  if (!focus || depth === null) {
    for (const id of lit) byKind.add(id);
    return byKind;
  }
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!edgeKinds.has(e.kind)) continue;
    (adj.get(e.s) ?? adj.set(e.s, []).get(e.s)!).push(e.t);
    (adj.get(e.t) ?? adj.set(e.t, []).get(e.t)!).push(e.s);
  }
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const o of adj.get(id) ?? []) {
        if (!seen.has(o) && byKind.has(o)) {
          seen.add(o);
          next.push(o);
        }
      }
    frontier = next;
  }
  for (const id of lit) seen.add(id);
  return seen;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(
  { graph, kinds, edgeKinds, focus, depth, lit, selected, onSelect },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pos = useRef(new Map<string, P>());
  const view = useRef({ k: 0.5, x: 0, y: 0 });
  const alpha = useRef(1);
  const fitted = useRef(false); // fit the view once the layout settles, until the person moves it
  const dirty = useRef(true);
  const hover = useRef<string | null>(null);
  const state = useRef({ nodes: [] as GraphNode[], edges: [] as GraphEdge[], lit, selected });
  const onSelectRef = useRef(onSelect); // the pointer handlers are set up once, so they read the latest callback here
  onSelectRef.current = onSelect;

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const parent = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of graph.edges) if (e.kind === 'contains') m.set(e.t, e.s);
    return m;
  }, [graph]);
  const visible = useMemo(
    () => visibleSet(graph, kinds, edgeKinds, focus, depth, lit),
    [graph, kinds, edgeKinds, focus, depth, lit],
  );

  // A new code base: start the layout again.
  useEffect(() => {
    pos.current = new Map();
    fitted.current = false;
  }, [graph]);

  // The visible set changed: place new nodes near their parent, and warm the simulation up again.
  useEffect(() => {
    const order: NodeKind[] = ['folder', 'file', 'class', 'interface', 'function', 'method'];
    const nodes = graph.nodes
      .filter((n) => visible.has(n.id))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const n of nodes) {
      if (pos.current.has(n.id)) continue;
      let at: P | undefined;
      for (let p = parent.get(n.id); p && !at; p = parent.get(p)) at = pos.current.get(p);
      const a = hash(n.id) * Math.PI * 2;
      if (at) {
        const r = 10 + hash(n.id + 'r') * 30;
        pos.current.set(n.id, { x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r, vx: 0, vy: 0 });
      } else {
        const top = n.file.split('/')[0];
        const b = hash(top) * Math.PI * 2;
        const r = 300 + hash(n.id + 'r') * 200;
        pos.current.set(n.id, {
          x: Math.cos(b) * r + Math.cos(a) * 60,
          y: Math.sin(b) * r + Math.sin(a) * 60,
          vx: 0,
          vy: 0,
        });
      }
    }
    const edges = graph.edges.filter((e) => edgeKinds.has(e.kind) && visible.has(e.s) && visible.has(e.t));
    state.current = { ...state.current, nodes, edges };
    alpha.current = Math.max(alpha.current, 0.7);
    dirty.current = true;
  }, [graph, visible, edgeKinds, parent]);

  useEffect(() => {
    state.current = { ...state.current, lit, selected };
    dirty.current = true;
  }, [lit, selected]);

  function tick() {
    const { nodes, edges } = state.current;
    const a = alpha.current;
    const grid = new Map<string, P[]>();
    const ps: P[] = [];
    for (const n of nodes) {
      const p = pos.current.get(n.id);
      if (!p) continue;
      ps.push(p);
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(p);
    }
    for (const p of ps) {
      const cx = Math.floor(p.x / CELL);
      const cy = Math.floor(p.y / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (q === p) continue;
            let x = p.x - q.x;
            let y = p.y - q.y;
            let d2 = x * x + y * y;
            if (d2 > CELL * CELL) continue;
            if (d2 < 0.01) {
              x = Math.random() - 0.5;
              y = Math.random() - 0.5;
              d2 = 0.5;
            }
            const f = (600 * a) / d2;
            p.vx += x * f * 0.05;
            p.vy += y * f * 0.05;
          }
        }
      p.vx -= p.x * 0.0012 * a;
      p.vy -= p.y * 0.0012 * a;
    }
    for (const e of edges) {
      const p = pos.current.get(e.s);
      const q = pos.current.get(e.t);
      if (!p || !q) continue;
      const [len, k] = SPRING[e.kind];
      const x = q.x - p.x;
      const y = q.y - p.y;
      const d = Math.sqrt(x * x + y * y) || 1;
      const f = ((d - len) / d) * k * a;
      p.vx += x * f;
      p.vy += y * f;
      q.vx -= x * f;
      q.vy -= y * f;
    }
    for (const p of ps) {
      if (p.pinned) {
        p.vx = p.vy = 0;
        continue;
      }
      p.vx = Math.max(-40, Math.min(40, p.vx * 0.6));
      p.vy = Math.max(-40, Math.min(40, p.vy * 0.6));
      p.x += p.vx;
      p.y += p.vy;
    }
    alpha.current *= 0.985;
  }

  function fit() {
    const c = canvas.current;
    const ps = state.current.nodes.map((n) => pos.current.get(n.id)).filter(Boolean) as P[];
    if (!c || !ps.length) return;
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = c.clientWidth;
    const h = c.clientHeight;
    const k = Math.min(3, 0.9 * Math.min(w / (x1 - x0 + 40), h / (y1 - y0 + 40)));
    view.current = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    dirty.current = true;
  }

  useImperativeHandle(ref, () => ({
    fit: () => {
      fitted.current = true;
      fit();
    },
    centreOn(id: string) {
      const c = canvas.current;
      const p = pos.current.get(id);
      if (!c || !p) return;
      fitted.current = true;
      const k = Math.max(view.current.k, 1.6);
      view.current = { k, x: c.clientWidth / 2 - p.x * k, y: c.clientHeight / 2 - p.y * k };
      dirty.current = true;
    },
  }));

  function draw() {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const { k, x: tx, y: ty } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { nodes, edges, lit: hot, selected: sel } = state.current;
    const sx = (p: P) => p.x * k + tx;
    const sy = (p: P) => p.y * k + ty;

    ctx.lineWidth = 1;
    for (const kind of ['contains', 'imports', 'calls', 'extends'] as EdgeKind[]) {
      ctx.strokeStyle = EDGE_COLOUR[kind];
      ctx.beginPath();
      for (const e of edges) {
        if (e.kind !== kind) continue;
        const p = pos.current.get(e.s);
        const q = pos.current.get(e.t);
        if (!p || !q) continue;
        ctx.moveTo(sx(p), sy(p));
        ctx.lineTo(sx(q), sy(q));
      }
      ctx.stroke();
    }
    // Edges of the selected node, bright.
    if (sel) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const e of edges) {
        if (e.s !== sel && e.t !== sel) continue;
        const p = pos.current.get(e.s);
        const q = pos.current.get(e.t);
        if (!p || !q) continue;
        ctx.moveTo(sx(p), sy(p));
        ctx.lineTo(sx(q), sy(q));
      }
      ctx.stroke();
    }

    const scale = Math.max(0.6, Math.sqrt(k));
    for (const kind of Object.keys(KIND_COLOUR) as NodeKind[]) {
      ctx.fillStyle = KIND_COLOUR[kind];
      ctx.beginPath();
      for (const n of nodes) {
        if (n.kind !== kind) continue;
        const p = pos.current.get(n.id);
        if (!p) continue;
        const r = RADIUS[kind] * scale * (n.kind === 'file' ? 1 + Math.min(1, (n.lines ?? 0) / 800) : 1);
        ctx.moveTo(sx(p) + r, sy(p));
        ctx.arc(sx(p), sy(p), r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    const labels: GraphNode[] = [];
    ctx.lineWidth = 2;
    for (const n of nodes) {
      const isLit = hot.has(n.id);
      if (!isLit && n.id !== sel && n.id !== hover.current) continue;
      const p = pos.current.get(n.id);
      if (!p) continue;
      ctx.strokeStyle = n.id === sel ? '#ffffff' : n.id === hover.current ? 'rgba(255,255,255,0.6)' : '#facc15';
      ctx.beginPath();
      ctx.arc(sx(p), sy(p), RADIUS[n.kind] * scale + 4, 0, Math.PI * 2);
      ctx.stroke();
      labels.push(n);
    }
    if (k > 1.4) for (const n of nodes) if (n.kind === 'file' || n.kind === 'class') labels.push(n);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    let drawn = 0;
    const done = new Set<string>();
    for (const n of labels) {
      if (done.has(n.id) || drawn > 220) continue;
      done.add(n.id);
      const p = pos.current.get(n.id);
      if (!p) continue;
      const x = sx(p);
      const y = sy(p);
      if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
      const text = n.qual || n.name;
      ctx.fillStyle = 'rgba(11,16,32,0.75)';
      ctx.fillRect(x + 7, y - 7, ctx.measureText(text).width + 6, 14);
      ctx.fillStyle = n.id === sel || hot.has(n.id) ? '#fff' : '#cbd5e1';
      ctx.fillText(text, x + 10, y);
      drawn++;
    }
  }

  // The animation loop: simulate within a time budget each frame, then draw if anything changed.
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      if (alpha.current > 0.02) {
        const until = performance.now() + 9;
        while (alpha.current > 0.02 && performance.now() < until) tick();
        dirty.current = true;
        if (!fitted.current && alpha.current < 0.5) fit();
      }
      if (dirty.current) {
        draw();
        dirty.current = false;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const c = canvas.current;
    const observer = new ResizeObserver(() => (dirty.current = true));
    if (c) observer.observe(c);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Pointer handling: pan, zoom, drag a node, click to select.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let drag: { id: string | null; x: number; y: number; moved: boolean } | null = null;
    const at = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const hit = (x: number, y: number): string | null => {
      const { k, x: tx, y: ty } = view.current;
      let best: string | null = null;
      let bestD = 10 * 10;
      for (const n of state.current.nodes) {
        const p = pos.current.get(n.id);
        if (!p) continue;
        const dx = p.x * k + tx - x;
        const dy = p.y * k + ty - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = n.id;
        }
      }
      return best;
    };
    const down = (e: PointerEvent) => {
      const [x, y] = at(e);
      c.setPointerCapture(e.pointerId);
      drag = { id: hit(x, y), x, y, moved: false };
    };
    const move = (e: PointerEvent) => {
      const [x, y] = at(e);
      if (!drag) {
        const h = hit(x, y);
        if (h !== hover.current) {
          hover.current = h;
          c.style.cursor = h ? 'pointer' : 'grab';
          dirty.current = true;
        }
        return;
      }
      const dx = x - drag.x;
      const dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      fitted.current = true;
      if (drag.id) {
        const p = pos.current.get(drag.id);
        if (p) {
          const { k, x: tx, y: ty } = view.current;
          p.x = (x - tx) / k;
          p.y = (y - ty) / k;
          p.pinned = true;
          alpha.current = Math.max(alpha.current, 0.15);
        }
      } else {
        view.current.x += dx;
        view.current.y += dy;
      }
      drag.x = x;
      drag.y = y;
      dirty.current = true;
    };
    const up = () => {
      if (drag && !drag.moved) onSelectRef.current(drag.id);
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      fitted.current = true;
      const [x, y] = at(e);
      const v = view.current;
      const k = Math.max(0.05, Math.min(8, v.k * Math.exp(-e.deltaY * 0.0015)));
      v.x = x - ((x - v.x) * k) / v.k;
      v.y = y - ((y - v.y) * k) / v.k;
      v.k = k;
      dirty.current = true;
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('wheel', wheel, { passive: false });
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('wheel', wheel);
    };
  }, []);

  return (
    <canvas
      ref={canvas}
      className="cg-canvas"
      aria-label={`Code graph: ${state.current.nodes.length || byId.size} nodes. Click a node to see its code.`}
    />
  );
});
