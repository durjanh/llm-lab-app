import type { ReactNode } from 'react';

/** A labelled slider with its value beside it. */
export function Slider({ label, value, min, max, step = 1, onChange, show }: {
  label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; show?: (v: number) => string;
}) {
  return (
    <label className="bm-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <b className="mono">{show ? show(value) : value}</b>
    </label>
  );
}

/** Small labelled numbers. */
export function Readout({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <div className="bm-readout">
      {items.map(([label, value], i) => (
        <div key={i}>
          <b className="mono">{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
