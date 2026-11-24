import { useState } from 'react';
import { NEEDS, recommend, type Need, type VectorScale } from './stores';

/** Tick the access patterns a workload has, and see which stores fit and how they work together. */
export function StoreChooser() {
  const [needs, setNeeds] = useState<Need[]>(['tx', 'similar']);
  const [scale, setScale] = useState<VectorScale>('small');
  const advice = recommend(needs, scale);
  const toggle = (n: Need) => setNeeds((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  return (
    <div className="card di-demo">
      <fieldset className="di-rules">
        <legend className="small muted">What does the workload need?</legend>
        {NEEDS.map((n) => (
          <label key={n.id} className="di-check">
            <input type="checkbox" checked={needs.includes(n.id)} onChange={() => toggle(n.id)} />
            <span>{n.label}</span>
          </label>
        ))}
        {needs.includes('similar') && (
          <label className="di-inline">
            How many vectors?{' '}
            <select value={scale} onChange={(e) => setScale(e.target.value as VectorScale)}>
              <option value="small">Up to a few million</option>
              <option value="large">Tens of millions or more</option>
            </select>
          </label>
        )}
      </fieldset>

      <div aria-live="polite">
        {advice.stores.length === 0 ? (
          <p className="muted">Tick at least one need.</p>
        ) : (
          <div className="grid3 di-stores">
            {advice.stores.map((s) => (
              <div key={s.kind} className="di-store">
                <h3>{s.name}</h3>
                <p className="small muted">{s.examples}</p>
                <p className="small">
                  <b>Why:</b> {s.why}
                </p>
                <p className="small">
                  <b>Trade-off:</b> {s.tradeoff}
                </p>
              </div>
            ))}
          </div>
        )}
        {advice.combos.length > 0 && (
          <div className="note">
            <b>How they fit together</b>
            <ul className="di-issues">
              {advice.combos.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
