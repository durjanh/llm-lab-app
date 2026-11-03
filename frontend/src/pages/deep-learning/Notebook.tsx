import type { ReactNode } from 'react';

interface NotebookProps {
  id: string; // e.g. "3.1", also the section's anchor
  title: string;
  /** What the notebook teaches, in a sentence or two. */
  intro: ReactNode;
  /** Things to try with the controls, each a short instruction. */
  tryThis?: ReactNode[];
  /** The point to take away. */
  takeaway?: ReactNode;
  children: ReactNode;
}

/** One notebook of the book, as a section: what it shows, the interactive part, things to try, the takeaway. */
export function Notebook({ id, title, intro, tryThis, takeaway, children }: NotebookProps) {
  return (
    <section id={`nb-${id}`} className="dl-nb card">
      <div className="dl-nb-head">
        <span className="dl-num">{id}</span>
        <h3>{title}</h3>
      </div>
      <p className="dl-intro">{intro}</p>
      <div className="dl-body">{children}</div>
      {tryThis && tryThis.length > 0 && (
        <div className="dl-try small">
          <b>Try this</b>
          <ul>
            {tryThis.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {takeaway && <p className="dl-takeaway small"><b>Takeaway:</b> {takeaway}</p>}
    </section>
  );
}

interface SliderProps {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** How the value is shown; defaults to the number itself. */
  show?: (v: number) => string;
}

/** A labelled range slider with its value beside it. */
export function Slider({ label, value, min, max, step = 0.01, onChange, show }: SliderProps) {
  return (
    <label className="dl-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="mono">{show ? show(value) : String(+value.toFixed(3))}</span>
    </label>
  );
}

/** A row of choice chips. */
export function Chips<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o.id} className={`chip-btn ${o.id === value ? 'on' : ''}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small labelled numbers under a plot, such as the loss and the step. */
export function Readout({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <div className="dl-readout">
      {items.map(([k, v], i) => (
        <div key={i}>
          <b className="mono">{v}</b>
          <span>{k}</span>
        </div>
      ))}
    </div>
  );
}
