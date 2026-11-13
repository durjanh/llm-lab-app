import { useMemo, useState } from 'react';
import type { GraphEntity, KnowledgeGraph } from '@/services/graphragService';

/* The knowledge graph as an SVG, laid out once by a small force simulation (Fruchterman-Reingold): every pair of
   entities pushes apart, each relationship pulls its two ends together, and the push and pull shrink step by step until
   the layout settles. Positions start on a circle in a fixed order, so the same graph is drawn the same way each time. */

export const COMMUNITY_COLOURS = [
  '#6366f1',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#06b6d4',
  '#d946ef',
  '#84cc16',
  '#f97316',
  '#0ea5e9',
  '#a855f7',
  '#14b8a6',
  '#eab308',
];
export const communityColour = (c: number) => (c < 0 ? '#94a3b8' : COMMUNITY_COLOURS[c % COMMUNITY_COLOURS.length]);

const W = 960;
const H = 600;
const PAD = 40;

interface Point {
  x: number;
  y: number;
}

function layout(graph: KnowledgeGraph): Map<string, Point> {
  const keys = graph.entities.map((e) => e.key);
  const n = keys.length;
  const index = new Map(keys.map((k, i) => [k, i]));
  const pos: Point[] = keys.map((_, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    return { x: W / 2 + (W / 3) * Math.cos(a), y: H / 2 + (H / 3) * Math.sin(a) };
  });
  // Entities of one community start next to each other, which helps the groups settle apart.
  const order = [...graph.entities].sort((a, b) => a.community - b.community || a.key.localeCompare(b.key));
  order.forEach((e, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    pos[index.get(e.key)!] = { x: W / 2 + (W / 3) * Math.cos(a), y: H / 2 + (H / 3) * Math.sin(a) };
  });
  const edges = graph.relations
    .map((r) => [index.get(r.source), index.get(r.target), r.strength] as const)
    .filter((e): e is readonly [number, number, number] => e[0] !== undefined && e[1] !== undefined);
  const k = Math.sqrt(((W - 2 * PAD) * (H - 2 * PAD)) / Math.max(1, n)) * 0.75;
  let temperature = W / 8;
  const steps = n > 250 ? 160 : 320;
  for (let step = 0; step < steps; step++) {
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let x = pos[i].x - pos[j].x;
        let y = pos[i].y - pos[j].y;
        let d2 = x * x + y * y;
        if (d2 < 0.01) {
          x = 0.1 * ((i % 7) - 3);
          y = 0.1 * ((j % 5) - 2);
          d2 = x * x + y * y + 0.01;
        }
        const f = (k * k) / d2;
        dx[i] += x * f;
        dy[i] += y * f;
        dx[j] -= x * f;
        dy[j] -= y * f;
      }
    }
    for (const [a, b, w] of edges) {
      const x = pos[a].x - pos[b].x;
      const y = pos[a].y - pos[b].y;
      const d = Math.sqrt(x * x + y * y) || 0.01;
      const f = (d / k) * (0.5 + w / 10);
      dx[a] -= x * f;
      dy[a] -= y * f;
      dx[b] += x * f;
      dy[b] += y * f;
    }
    for (let i = 0; i < n; i++) {
      // a weak pull to the middle keeps unconnected entities on the page
      dx[i] += (W / 2 - pos[i].x) * 0.02 * k;
      dy[i] += (H / 2 - pos[i].y) * 0.02 * k;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const move = Math.min(len, temperature);
      pos[i].x = Math.min(W - PAD, Math.max(PAD, pos[i].x + (dx[i] / len) * move));
      pos[i].y = Math.min(H - PAD, Math.max(PAD, pos[i].y + (dy[i] / len) * move));
    }
    temperature *= 0.985;
  }
  return new Map(keys.map((key, i) => [key, pos[i]]));
}

export interface GraphHighlight {
  entities: Set<string>;
  seeds: Set<string>;
  communities: Set<number>;
}

export function GraphView({
  graph,
  highlight,
  selected,
  onSelect,
}: {
  graph: KnowledgeGraph;
  highlight: GraphHighlight | null;
  selected: string | null;
  onSelect: (e: GraphEntity | null) => void;
}) {
  const positions = useMemo(() => layout(graph), [graph]);
  const [hover, setHover] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(graph.entities.map((e) => [e.key, e])), [graph]);
  const lit = (e: GraphEntity) => !highlight || highlight.entities.has(e.key) || highlight.communities.has(e.community);
  const near = new Set<string>();
  const focus = hover ?? selected;
  if (focus) {
    near.add(focus);
    for (const r of graph.relations) {
      if (r.source === focus) near.add(r.target);
      if (r.target === focus) near.add(r.source);
    }
  }
  const radius = (e: GraphEntity) => 5 + Math.min(9, Math.sqrt(e.degree) * 2.4);

  return (
    <svg
      className="gr-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="The knowledge graph"
      onClick={() => onSelect(null)}
    >
      <g>
        {graph.relations.map((r) => {
          const a = positions.get(r.source);
          const b = positions.get(r.target);
          if (!a || !b) return null;
          const on = focus ? r.source === focus || r.target === focus : true;
          const [ea, eb] = [byKey.get(r.source), byKey.get(r.target)];
          const both = !highlight || (!!ea && !!eb && lit(ea) && lit(eb));
          return (
            <line
              key={`${r.source}|${r.target}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="gr-edge"
              strokeWidth={0.6 + r.strength / 5}
              opacity={on && both ? 0.55 : 0.1}
            >
              <title>{r.description}</title>
            </line>
          );
        })}
      </g>
      <g>
        {graph.entities.map((e) => {
          const p = positions.get(e.key)!;
          const on = lit(e) && (!focus || near.has(e.key));
          const seed = highlight?.seeds.has(e.key);
          const showLabel = e.degree >= 3 || e.key === focus || near.has(e.key) || (highlight && lit(e));
          return (
            <g
              key={e.key}
              className="gr-node"
              transform={`translate(${p.x},${p.y})`}
              opacity={on ? 1 : 0.18}
              onMouseEnter={() => setHover(e.key)}
              onMouseLeave={() => setHover(null)}
              onClick={(ev) => {
                ev.stopPropagation();
                onSelect(e);
              }}
            >
              <circle
                r={radius(e)}
                fill={communityColour(e.community)}
                className={`${seed ? 'seed' : ''} ${e.key === selected ? 'selected' : ''}`}
              >
                <title>{`${e.name} (${e.type})\n${e.description}`}</title>
              </circle>
              {showLabel && (
                <text x={radius(e) + 3} y={4}>
                  {e.name}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
