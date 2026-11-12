import { useId, type KeyboardEvent } from 'react';
import { ArchIcon } from './ArchIcon';
import './arch-diagram.css';

/** A boundary drawn behind boxes: a machine, a cloud, a service. */
export interface DiagramGroup {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  dashed?: boolean;
  /** Label at the top right, clear of arrows that come down into the left of the group. */
  right?: boolean;
}

/** A box, named after the component it stands for. */
export interface DiagramBox {
  part: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string[];
  sub?: string[];
  /** Icon above centred text, for narrow boxes; otherwise the icon sits to the left. */
  stack?: boolean;
  /** A dashed border: something that arrives from outside rather than a component. */
  dashed?: boolean;
}

/** An arrow (an SVG path in the diagram's units), and the views whose requests travel along it. */
export interface DiagramArrow {
  d: string;
  uses: string[];
  both?: boolean;
}

export interface DiagramLabel {
  x: number;
  y: number;
  lines: string[];
  anchor?: 'start' | 'middle' | 'end';
  uses: string[];
}

/** What the diagram needs to know about a component. */
export interface DiagramPart {
  id: string;
  name: string;
  icon: string;
  uses: string[];
  /** Drawn in navy: the one place something important lives. */
  core?: boolean;
}

const LINE = 16;

/**
 * An architecture diagram: boundaries, clickable boxes, and an arrow for each call one component makes to another.
 * Selecting a box reports its component; choosing a view (`active`) brings forward the boxes and arrows it uses.
 */
export function ArchDiagram({
  width,
  height,
  label,
  groups,
  headings = [],
  boxes,
  arrows,
  labels,
  parts,
  active,
  selected,
  onSelect,
}: {
  width: number;
  height: number;
  label: string;
  groups: DiagramGroup[];
  headings?: { x: number; y: number; text: string }[];
  boxes: DiagramBox[];
  arrows: DiagramArrow[];
  labels: DiagramLabel[];
  parts: DiagramPart[];
  active: string | null;
  selected: string;
  onSelect: (part: string) => void;
}) {
  const marker = `arch-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const used = (uses: string[]) => (active === null ? '' : uses.includes(active) ? ' on' : ' off');

  return (
    <div className="arch-diagram-wrap">
      <svg className="arch-svg" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label}>
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>

        {headings.map((h) => (
          <text key={h.text} className="arch-group-label" x={h.x} y={h.y}>
            {h.text}
          </text>
        ))}
        {groups.map((g) => (
          <g key={g.label}>
            <rect
              className={`arch-group${g.dashed ? ' dashed' : ''}`}
              x={g.x}
              y={g.y}
              width={g.w}
              height={g.h}
              rx={10}
            />
            <text
              className="arch-group-label"
              x={g.right ? g.x + g.w - 14 : g.x + 14}
              y={g.y + 22}
              textAnchor={g.right ? 'end' : 'start'}
            >
              {g.label}
            </text>
          </g>
        ))}

        {boxes.map((b) => {
          const part = parts.find((p) => p.id === b.part);
          if (!part) return null;
          const dim = active !== null && !part.uses.includes(active);
          const lines = [...b.title.map((t) => ({ t, bold: true })), ...(b.sub ?? []).map((t) => ({ t, bold: false }))];
          const choose = () => onSelect(b.part);
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              choose();
            }
          };
          const iconSize = b.stack ? 30 : 26;
          const iconX = b.stack ? b.x + b.w / 2 - iconSize / 2 : b.x + 10;
          const iconY = b.stack ? b.y + (b.h - iconSize - lines.length * LINE - 6) / 2 : b.y + b.h / 2 - iconSize / 2;
          const textX = b.stack ? b.x + b.w / 2 : b.x + 44;
          const firstLine = b.stack ? iconY + iconSize + 18 : b.y + b.h / 2 - (lines.length * LINE) / 2 + 12;
          return (
            <g
              key={b.part}
              className={`arch-node${part.core ? ' core' : ''}${dim ? ' dim' : ''}${b.part === selected ? ' sel' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={part.name}
              aria-pressed={b.part === selected}
              onClick={choose}
              onKeyDown={onKey}
            >
              <rect className={b.dashed ? 'dashed' : ''} x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
              <foreignObject x={iconX} y={iconY} width={iconSize} height={iconSize}>
                <ArchIcon name={part.icon} size={iconSize} />
              </foreignObject>
              <text x={textX} y={firstLine} textAnchor={b.stack ? 'middle' : 'start'}>
                {lines.map((l, i) => (
                  <tspan key={i} x={textX} dy={i === 0 ? 0 : LINE} className={l.bold ? 'b' : 's'}>
                    {l.t}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}

        {arrows.map((a) => (
          <path
            key={a.d}
            className={`arch-edge${used(a.uses)}`}
            d={a.d}
            markerEnd={`url(#${marker})`}
            markerStart={a.both ? `url(#${marker})` : undefined}
          />
        ))}

        {labels.map((l) => (
          <text
            key={l.lines.join(' ')}
            className={`arch-edge-label${used(l.uses)}`}
            x={l.x}
            y={l.y}
            textAnchor={l.anchor ?? 'start'}
          >
            {l.lines.map((t, i) => (
              <tspan key={i} x={l.x} dy={i === 0 ? 0 : 14}>
                {t}
              </tspan>
            ))}
          </text>
        ))}
      </svg>
    </div>
  );
}
