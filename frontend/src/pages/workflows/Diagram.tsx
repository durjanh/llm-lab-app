import type { GraphShape } from '@/services/workflowsService';

export type NodeState = 'active' | 'done' | 'failed';

const W = 118;
const H = 38;
const GAP_X = 62;
const GAP_Y = 16;
const PAD = 14;

const label = (id: string) => id.replace(/^input-conversation$/, 'input').replace(/_/g, ' ');

/** Columns by longest path from the start, once any edge that points backwards has been set aside. */
function place(g: GraphShape) {
  const out = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  g.edges.forEach((e) => out.get(e.from)?.push(e.to));
  const back = new Set<string>();
  const seen = new Map<string, 'open' | 'closed'>();
  const visit = (id: string) => {
    seen.set(id, 'open');
    for (const to of out.get(id) ?? []) {
      if (seen.get(to) === 'open') back.add(`${id}>${to}`);
      else if (!seen.has(to)) visit(to);
    }
    seen.set(id, 'closed');
  };
  visit(g.start);
  g.nodes.forEach((n) => !seen.has(n.id) && visit(n.id));

  const column = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < g.nodes.length; pass++) {
    for (const e of g.edges) {
      if (!back.has(`${e.from}>${e.to}`))
        column.set(e.to, Math.max(column.get(e.to) ?? 0, (column.get(e.from) ?? 0) + 1));
    }
  }
  const columns: string[][] = [];
  g.nodes.forEach((n) => (columns[column.get(n.id) ?? 0] ??= []).push(n.id));
  const tallest = Math.max(...columns.map((c) => c?.length ?? 0));
  const height = tallest * H + (tallest - 1) * GAP_Y + PAD * 2 + 22;
  const at = new Map<string, { x: number; y: number }>();
  columns.forEach((ids, x) => {
    const span = ids.length * H + (ids.length - 1) * GAP_Y;
    ids.forEach((id, i) => at.set(id, { x: PAD + x * (W + GAP_X), y: (height - 22 - span) / 2 + i * (H + GAP_Y) }));
  });
  return { at, back, width: PAD * 2 + columns.length * W + (columns.length - 1) * GAP_X, height };
}

/** The workflow's real graph, read from the built object, with each step lit as the run reaches it. */
export function Diagram({ graph, states }: { graph: GraphShape; states: Record<string, NodeState> }) {
  const { at, back, width, height } = place(graph);
  const pairs = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
  const drawn = graph.edges.filter((e) => !(pairs.has(`${e.to}>${e.from}`) && e.from > e.to)); // a two-way pair is one line
  return (
    <div className="wf-diagram">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width }} role="img" aria-label="Workflow graph">
        <defs>
          <marker
            id="wf-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 8 4 0 8z" className="wf-head" />
          </marker>
        </defs>
        {drawn.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const two = pairs.has(`${e.to}>${e.from}`);
          const isBack = back.has(`${e.from}>${e.to}`) && !two;
          const key = `${e.from}>${e.to}`;
          if (isBack) {
            const y = height - 16;
            const d = `M${a.x + W / 2} ${a.y + H} C${a.x + W / 2} ${y} ${b.x + W / 2} ${y} ${b.x + W / 2} ${b.y + H}`;
            return <path key={key} d={d} className="wf-edge back" markerEnd="url(#wf-arrow)" />;
          }
          const [left, right] = a.x <= b.x ? [a, b] : [b, a];
          const x1 = left.x + W;
          const x2 = right.x === left.x ? right.x + W : right.x;
          const y1 = left.y + H / 2;
          const y2 = right.y + H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={key}
              d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
              className={`wf-edge ${e.kind}`}
              markerEnd="url(#wf-arrow)"
              markerStart={two ? 'url(#wf-arrow)' : undefined}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const p = at.get(n.id);
          if (!p) return null;
          return (
            <g key={n.id} className={`wf-node ${n.agent ? 'agent' : 'code'} ${states[n.id] ?? ''}`}>
              <rect x={p.x} y={p.y} width={W} height={H} rx="9" />
              <text x={p.x + W / 2} y={p.y + H / 2 + 4} textAnchor="middle">
                {label(n.id)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
