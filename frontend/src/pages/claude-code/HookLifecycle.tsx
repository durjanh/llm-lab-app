import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { EVENT_BY_NAME, HOOK_EVENTS, eventHtml, lifecycleSvg } from './hookEvents';

/* The full hook lifecycle as a clickable chart: pick an event to see when it fires and what a hook on it can do, or
   light up every event that can block. Its own state only, so the page around it never re-renders. */

const CAN_BLOCK = HOOK_EVENTS.filter((e) => !/^(Cannot|Ignored|The original)/.test(e.exit2)).map((e) => e.name);

type View = { kind: 'event'; name: string } | { kind: 'block' } | { kind: 'observe' };

export function HookLifecycle() {
  const [view, setView] = useState<View>({ kind: 'event', name: 'PreToolUse' });
  const lit =
    view.kind === 'event'
      ? [view.name]
      : view.kind === 'block'
        ? CAN_BLOCK
        : HOOK_EVENTS.map((e) => e.name).filter((n) => !CAN_BLOCK.includes(n));

  // A box can hold two events (PostToolUse / PostToolUseFailure): a second click moves to the second one.
  const pick = (target: EventTarget) => {
    const g = (target as Element).closest?.('[data-ev]');
    if (!g) return;
    const events = (g.getAttribute('data-ev') || '').split(' ');
    const at = view.kind === 'event' ? events.indexOf(view.name) : -1;
    setView({ kind: 'event', name: events[(at + 1) % events.length] });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(e.target);
    }
  };

  return (
    <div className="hl-wrap">
      <div className="hl-chart">
        <div
          onClick={(e: MouseEvent) => pick(e.target)}
          onKeyDown={onKey}
          dangerouslySetInnerHTML={{ __html: lifecycleSvg(lit) }}
        />
      </div>
      <div className="hl-panel card">
        <div className="hl-lenses" role="group" aria-label="Highlight">
          <button
            type="button"
            className={`btn small${view.kind === 'block' ? ' primary' : ''}`}
            aria-pressed={view.kind === 'block'}
            onClick={() => setView({ kind: 'block' })}
          >
            Can block ({CAN_BLOCK.length})
          </button>
          <button
            type="button"
            className={`btn small${view.kind === 'observe' ? ' primary' : ''}`}
            aria-pressed={view.kind === 'observe'}
            onClick={() => setView({ kind: 'observe' })}
          >
            Observe only ({HOOK_EVENTS.length - CAN_BLOCK.length})
          </button>
        </div>
        {view.kind === 'event' ? (
          <div aria-live="polite" dangerouslySetInnerHTML={{ __html: eventHtml(view.name) }} />
        ) : (
          <div aria-live="polite">
            <h4>{view.kind === 'block' ? 'Events a hook can stop or change' : 'Events a hook can only observe'}</h4>
            <p className="small muted">
              {view.kind === 'block'
                ? 'Exit code 2, or a JSON decision, stops or changes what happens next. Pick one for the details.'
                : 'Exit code 2 does not stop anything here. Use them to log, notify, add context or clean up.'}
            </p>
            <ul className="hl-list">
              {lit.map((n) => (
                <li key={n}>
                  <button type="button" className="linklike" onClick={() => setView({ kind: 'event', name: n })}>
                    <code>{n}</code>
                  </button>{' '}
                  <span className="small muted">{EVENT_BY_NAME[n].exit2}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="small muted hl-hint">
          Pick any box in the chart. A box with two events shows the second on a second click.
        </p>
      </div>
    </div>
  );
}
