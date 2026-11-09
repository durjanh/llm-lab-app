import { useEffect, useState, type FormEvent } from 'react';
import { storeWatchService as desk, type Alert, type DeskState } from '@/services/storewatchService';
import './storewatch.css';

function AlertCard({
  alert,
  high,
  name,
  run,
}: {
  alert: Alert;
  high: boolean;
  name: string;
  run: (p: Promise<DeskState>) => void;
}) {
  const [note, setNote] = useState('');
  const [watched, setWatched] = useState(false);
  return (
    <div className={`sw-item ${high ? 'high' : ''}`}>
      <div className="sw-row">
        <b>Alert {alert.id}</b>
        <span className={`sw-score ${high ? 'high' : ''}`}>Score {alert.score}</span>
        {high && <span className="sw-tag">Face held, admin alerted</span>}
      </div>
      <p>{alert.what.split('.')[0]}.</p>
      <p className="small muted">
        The footage for this invented person is described above. In a real shop you would watch the clip here.
      </p>
      <label className="sw-check">
        <input type="checkbox" checked={watched} onChange={(e) => setWatched(e.target.checked)} /> I watched the footage
      </label>
      <textarea
        rows={2}
        placeholder="What you saw: this is the evidence"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="sw-row">
        <button
          className="btn primary"
          onClick={() => run(desk.review(alert.id, { reviewer: name, theft: true, note, watched_footage: watched }))}
        >
          Confirm theft and add to watchlist
        </button>
        <button
          className="btn"
          onClick={() => run(desk.review(alert.id, { reviewer: name, theft: false, note, watched_footage: watched }))}
        >
          Not theft
        </button>
      </div>
    </div>
  );
}

/** The alert desk: what is automated, and the one step that is always a person's. */
export default function StoreWatchPage() {
  const [state, setState] = useState<DeskState | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('Sam Patel');
  const [threshold, setThreshold] = useState(80);
  const [form, setForm] = useState({ controller: '', lawful_basis: '', dpia_reference: '', signage: false });

  const run = (call: Promise<DeskState>) => {
    setError('');
    call.then(setState).catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    desk
      .state()
      .then(setState)
      .catch((err: Error) => setError(err.message));
  }, []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    run(desk.compliance(form));
  };

  if (!state)
    return (
      <main className="page-storewatch">
        <h1>Shoplifting alert desk</h1>
        <p className={error ? 'sw-error' : 'muted'}>
          {error ? `${error} This page needs the backend running.` : 'Loading…'}
        </p>
      </main>
    );

  const pending = state.alerts.filter((a) => a.status === 'pending');
  const decided = state.alerts.filter((a) => a.status !== 'pending');
  const open = state.matches.filter((m) => m.status === 'open');
  const closed = state.matches.filter((m) => m.status !== 'open');
  const wrong = closed.filter((m) => m.correct === 0).length;

  return (
    <main className="page-storewatch">
      <div className="kicker">Lab 49 · Human in the loop</div>
      <h1>Shoplifting alert desk</h1>
      <p className="lede">
        A camera system raises an alert, a person decides, and a confirmed thief is flagged next time they enter. The
        system alerts people automatically. Only a person can put someone on the list, or decide that a face at the door
        is really them.
      </p>
      <div className="sw-banner">
        <b>Simulation.</b> Every person here is invented and no camera or real face is involved. The behaviour alerts
        are scripted and the faces are random numbers. The rules are real, and the backend enforces them.
      </div>
      {error && <p className="sw-error">{error}</p>}

      <section className="card sw-step">
        <h2>1. Before anything runs</h2>
        {state.compliance ? (
          <p>
            Recorded for <b>{state.compliance.controller}</b>: DPIA {state.compliance.dpia_reference}. Basis:{' '}
            {state.compliance.lawful_basis}
          </p>
        ) : (
          <form className="sw-form" onSubmit={save}>
            <p className="small muted">
              Biometric data needs a lawful basis and an Article 9 condition under UK GDPR, and a DPIA first. This form
              only records your answers: filling it in does not make anything lawful. Take legal advice for a real shop.
            </p>
            <input
              required
              placeholder="Shop or company (the controller)"
              value={form.controller}
              onChange={(e) => setForm({ ...form, controller: e.target.value })}
            />
            <input
              required
              placeholder="Lawful basis and Article 9 condition"
              value={form.lawful_basis}
              onChange={(e) => setForm({ ...form, lawful_basis: e.target.value })}
            />
            <input
              required
              placeholder="DPIA reference"
              value={form.dpia_reference}
              onChange={(e) => setForm({ ...form, dpia_reference: e.target.value })}
            />
            <label className="sw-check">
              <input
                type="checkbox"
                checked={form.signage}
                onChange={(e) => setForm({ ...form, signage: e.target.checked })}
              />{' '}
              Signs tell customers before they enter
            </label>
            <button className="btn primary">Record</button>
          </form>
        )}
      </section>

      <section className="card sw-step">
        <h2>2. Behaviour alerts</h2>
        <p className="muted">
          A score of {state.high_score} or more alerts the admin at once and holds the face at the top of the queue. A
          held face cannot match at the door, and it is deleted after {state.hold_hours} hours if nobody reviews it.
        </p>
        <div className="sw-row">
          <button className="btn primary" disabled={!state.more_alerts} onClick={() => run(desk.nextAlert())}>
            {state.more_alerts ? 'Next behaviour alert' : 'No more alerts'}
          </button>
          <label className="sw-name">
            Reviewer <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        {pending.map((a) => (
          <AlertCard key={a.id} alert={a} high={a.score >= state.high_score} name={name} run={run} />
        ))}
        {decided.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Alert</th>
                <th>Score</th>
                <th>Decision</th>
                <th>By</th>
                <th>In this simulation</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>{a.score}</td>
                  <td>{a.status}</td>
                  <td>{a.reviewer ?? 'nobody'}</td>
                  <td>{a.truth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {state.high_score_rejected > 0 && (
          <p className="sw-lesson">
            <b>
              A person rejected {state.high_score_rejected} high-score alert{state.high_score_rejected > 1 ? 's' : ''}.
            </b>{' '}
            With automatic adding, that innocent person would now be flagged at every visit.
          </p>
        )}
      </section>

      <section className="card sw-step">
        <h2>Alerts to the admin and system</h2>
        {state.notices.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="sw-notices">
          {state.notices.map((n) => (
            <li key={n.id} className={n.level}>
              {n.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="card sw-step">
        <h2>3. Watchlist</h2>
        {state.watchlist.length === 0 && <p className="muted">Empty.</p>}
        {state.watchlist.map((e) => (
          <div key={e.id} className="sw-item">
            <div className="sw-row">
              <b>Invented person {e.person}</b>
              <span className={`sw-tag ${e.status}`}>{e.status === 'active' ? 'Live' : 'Held: cannot match'}</span>
              <span className="small muted">
                Deleted on {e.expires.slice(0, 10)}
                {e.added_by ? ` · added by ${e.added_by}` : ''}
              </span>
              <button className="btn small" onClick={() => run(desk.remove(e.id, name, 'Erasure request or mistake'))}>
                Remove
              </button>
            </div>
            <p className="small">{e.reason}</p>
          </div>
        ))}
        <div className="sw-row">
          <button className="btn" onClick={() => run(desk.advance(4))}>
            Move the clock 4 days
          </button>
          <button className="btn" onClick={() => run(desk.advance(30))}>
            Move the clock 30 days
          </button>
          <span className="small muted">
            Live entries last {state.retention_days} days in this example. The real period comes from your DPIA. Clock:
            +{state.days_ahead} days.
          </span>
        </div>
      </section>

      <section className="card sw-step">
        <h2>4. At the door</h2>
        <p className="muted">
          Each visitor is compared with live entries only. Someone who matches nobody is forgotten at once. Above{' '}
          {state.high_score} also alerts the admin, but it is still a possible match.
        </p>
        <div className="sw-row">
          <button
            className="btn primary"
            disabled={!state.more_visitors}
            onClick={() => run(desk.nextVisitor(threshold))}
          >
            {state.more_visitors ? 'Next person enters' : 'No more visitors'}
          </button>
          <label className="sw-name">
            Match threshold{' '}
            <input type="range" min={60} max={95} value={threshold} onChange={(e) => setThreshold(+e.target.value)} />{' '}
            {threshold}
          </label>
          <span className="small muted">Forgotten so far: {state.visitors_discarded}</span>
        </div>
        {open.map((m) => (
          <div key={m.id} className={`sw-item ${m.high ? 'high' : ''}`}>
            <div className="sw-row">
              <b>Possible match with invented person {m.person}</b>
              <span className={`sw-score ${m.high ? 'high' : ''}`}>Similarity {m.score}</span>
            </div>
            <p className="small muted">Compare the live view with the record before anyone speaks to this person.</p>
            <div className="sw-row">
              <button className="btn" onClick={() => run(desk.decide(m.id, name, true))}>
                Same person
              </button>
              <button className="btn" onClick={() => run(desk.decide(m.id, name, false))}>
                Not the same person
              </button>
            </div>
          </div>
        ))}
        {closed.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Similarity</th>
                <th>Staff said</th>
                <th>Really was</th>
                <th>Right?</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((m) => (
                <tr key={m.id}>
                  <td>{m.score}</td>
                  <td>{m.status === 'same' ? 'same person' : 'not the same'}</td>
                  <td>{m.visitor}</td>
                  <td>{(m.status === 'same') === (m.correct === 1) ? 'Yes' : 'No: wrong call'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {wrong > 0 && (
          <p className="sw-lesson">
            <b>
              The camera matched {wrong} innocent look-alike{wrong > 1 ? 's' : ''}.
            </b>{' '}
            That is why the match is only ever a prompt for a person to look.
          </p>
        )}
      </section>

      <section className="card sw-step">
        <h2>Audit log</h2>
        <ul className="sw-audit">
          {state.audit.map((a) => (
            <li key={a.id}>
              <span className="muted">{a.at.slice(0, 16).replace('T', ' ')}</span> <b>{a.actor}</b>: {a.action}
            </li>
          ))}
        </ul>
        <button className="btn" onClick={() => run(desk.reset())}>
          Start again
        </button>
      </section>
    </main>
  );
}
