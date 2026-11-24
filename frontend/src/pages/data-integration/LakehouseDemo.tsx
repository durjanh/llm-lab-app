import { useState } from 'react';
import { ALL_RULES, NO_RULES, RAW, runMedallion, type Rules } from './medallion';

const RULES: [keyof Rules, string, string][] = [
  ['dedupe', 'Deduplicate', 'one row per ticket id, so a replayed load is not counted twice'],
  ['dates', 'Parse and validate dates', 'four formats to one; impossible dates quarantined'],
  ['requireBody', 'Require text', 'tickets with no text quarantined'],
  ['conform', 'Conform the schema', 'the renamed priority column and product spellings mapped to one'],
  ['maskPii', 'Mask personal data', 'phone numbers and emails replaced before text is embedded'],
];

/** Invented support tickets through bronze, silver and gold, with the quality rules as switches. */
export function LakehouseDemo() {
  const [rules, setRules] = useState<Rules>(NO_RULES);
  const r = runMedallion(rules);

  return (
    <div className="card di-demo">
      <fieldset className="di-rules">
        <legend className="small muted">Rules applied from bronze to silver</legend>
        {RULES.map(([k, label, hint]) => (
          <label key={k} className="di-check">
            <input type="checkbox" checked={rules[k]} onChange={(e) => setRules({ ...rules, [k]: e.target.checked })} />
            <span>
              <b>{label}</b> <span className="muted">· {hint}</span>
            </span>
          </label>
        ))}
        <div className="row">
          <button type="button" className="btn small" onClick={() => setRules(ALL_RULES)}>
            All rules on
          </button>
          <button type="button" className="btn small" onClick={() => setRules(NO_RULES)}>
            All off
          </button>
        </div>
      </fieldset>

      <div className="di-layers" aria-live="polite">
        <div className="di-layer bronze">
          <span className="di-layer-name">Bronze</span>
          <b>{r.bronze}</b>
          <span className="small muted">rows, as landed</span>
        </div>
        <div className="di-layer silver">
          <span className="di-layer-name">Silver</span>
          <b>{r.silver.length}</b>
          <span className="small muted">{r.quarantine.length} quarantined</span>
        </div>
        <div className="di-layer gold">
          <span className="di-layer-name">Gold</span>
          <b>{r.gold.length}</b>
          <span className="small muted">month × product rows</span>
        </div>
        <div className="di-layer serve">
          <span className="di-layer-name">Features · index</span>
          <b>
            {r.features.length} · {r.chunks.length}
          </b>
          <span className="small muted">customers · chunks</span>
        </div>
      </div>

      {r.issues.length ? (
        <div className="note">
          <b>What reaches the model and the reports:</b>
          <ul className="di-issues">
            {r.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="di-ok">
          Every rule is on: the gold table, the features and the index are built only from clean, unique rows.
        </p>
      )}

      <details>
        <summary>Bronze: the raw rows ({RAW.length})</summary>
        <div className="table-wrap">
          <table className="t di-small">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Id</th>
                <th>Created</th>
                <th>Product</th>
                <th>Priority</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {RAW.map((x, i) => (
                <tr key={i}>
                  <td>{x.batch}</td>
                  <td>{x.id}</td>
                  <td>{x.created}</td>
                  <td>{JSON.stringify(x.product)}</td>
                  <td>{x.priority ?? (x.prio ? `prio: ${x.prio}` : '')}</td>
                  <td>{x.body || <span className="muted">(empty)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>
          Silver ({r.silver.length}) and quarantine ({r.quarantine.length})
        </summary>
        <div className="table-wrap">
          <table className="t di-small">
            <thead>
              <tr>
                <th>Id</th>
                <th>Date</th>
                <th>Product</th>
                <th>Priority</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {r.silver.map((s, i) => (
                <tr key={i}>
                  <td>{s.id}</td>
                  <td>{s.date}</td>
                  <td>{s.product}</td>
                  <td>{s.priority ?? <span className="di-bad">missing</span>}</td>
                  <td>{s.body || <span className="di-bad">(empty)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.quarantine.length > 0 && (
          <ul className="small">
            {r.quarantine.map((q) => (
              <li key={`${q.id}-${q.batch}`}>
                <b>{q.id}</b> (batch {q.batch}): {q.reason}
              </li>
            ))}
          </ul>
        )}
      </details>
      <details open>
        <summary>Gold: tickets by month and product</summary>
        <div className="table-wrap">
          <table className="t di-small">
            <thead>
              <tr>
                <th>Month</th>
                <th>Product</th>
                <th className="num">Tickets</th>
                <th className="num">High priority</th>
              </tr>
            </thead>
            <tbody>
              {r.gold.map((g) => (
                <tr key={`${g.month}|${g.product}`}>
                  <td className={/^\d{4}-(0[1-9]|1[0-2])$/.test(g.month) ? undefined : 'di-bad'}>{g.month}</td>
                  <td>{g.product}</td>
                  <td className="num">{g.tickets}</td>
                  <td className="num">{g.high}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>The vector index ({r.chunks.length} chunks)</summary>
        <ul className="small di-chunks">
          {r.chunks.map((c, i) => (
            <li key={i} className={c.pii || !c.text ? 'di-bad' : undefined}>
              <b>{c.id}</b>: {c.text || '(empty)'}
              {c.pii ? ' ← personal data' : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
