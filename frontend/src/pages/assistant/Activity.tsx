import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AssistantEvent } from '@/services/assistantService';
import { describe, type Lane } from './state';

/* The activity panel: every step of a turn, by agent, newest at the bottom, each row expandable to its full input
   or output. It follows new rows only while the reader is at the bottom, so scrolling up to read stops the jump. */

const time = (ts: number) => (Number.isFinite(ts) ? new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) : '');

function Row({ e, showAgent }: { e: AssistantEvent; showAgent: boolean }) {
  const r = describe(e);
  const agent = 'agent' in e ? e.agent : 'main';
  const head = (
    <>
      <span className="as-row-time">{time(e.ts)}</span>
      <span className="as-row-icon" aria-hidden="true">
        {r.icon}
      </span>
      {showAgent && <span className="as-row-agent">{agent}</span>}
      <span className="as-row-title">{r.title}</span>
    </>
  );
  return (
    <li className={`as-row ${r.tone}`}>
      {r.detail ? (
        <details>
          <summary>{head}</summary>
          <pre className="as-row-detail">{r.detail}</pre>
        </details>
      ) : (
        <div className="as-row-plain">{head}</div>
      )}
    </li>
  );
}

export function Activity({
  lanes,
  loading,
  error,
  empty,
}: {
  lanes: Lane[];
  loading?: boolean;
  error?: string | null;
  empty: string;
}) {
  const [only, setOnly] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const rows = useMemo(() => {
    const chosen = only ? lanes.filter((l) => l.agent === only) : lanes;
    return chosen.flatMap((l) => l.events).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  }, [lanes, only]);
  const count = rows.length;

  useEffect(() => {
    if (only && !lanes.some((l) => l.agent === only)) setOnly(null);
  }, [lanes, only]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  const onScroll = () => {
    const el = box.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const network = rows.filter((e) => e.type === 'tool_call' && e.network).length;

  return (
    <div className="as-activity">
      {lanes.length > 1 && (
        <div className="chips as-lanes" role="group" aria-label="Show one agent">
          <button type="button" className={`chip-btn${only === null ? ' on' : ''}`} onClick={() => setOnly(null)}>
            All agents
          </button>
          {lanes.map((l) => (
            <button
              key={l.agent}
              type="button"
              className={`chip-btn${only === l.agent ? ' on' : ''}`}
              onClick={() => setOnly(l.agent)}
              title={l.brief ?? undefined}
            >
              {l.agent}
              {l.status === 'running' ? ' ●' : ''} ${l.costUsd.toFixed(3)}
            </button>
          ))}
        </div>
      )}
      {only && lanes.find((l) => l.agent === only)?.brief && (
        <p className="small as-lane-brief">Brief: {lanes.find((l) => l.agent === only)?.brief}</p>
      )}
      {network > 0 && (
        <p className="small as-net-note">
          🌐 {network} command{network === 1 ? '' : 's'} reached the network in this view.
        </p>
      )}
      <div className="as-log" ref={box} onScroll={onScroll} tabIndex={0} aria-label="Activity log">
        {loading && <p className="small muted">Loading the log…</p>}
        {error && <p className="small as-bad">{error}</p>}
        {!loading && !error && count === 0 && <p className="small muted">{empty}</p>}
        <ol>
          {rows.map((e, i) => (
            <Row key={i} e={e} showAgent={lanes.length > 1 && only === null} />
          ))}
        </ol>
      </div>
    </div>
  );
}
