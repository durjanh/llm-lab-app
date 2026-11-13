import { useEffect, useRef, useState, type FormEvent } from 'react';
import { storeWatchService as desk, type Alert, type DeskState } from '@/services/storewatchService';
import { LiveDesk, type LiveStats } from './LiveDesk';
import './storewatch.css';

/** A person's label: camera people are numbered, and scripted ones are invented. */
const who = (person: string) => (person.startsWith('Camera') ? person : `Invented person ${person}`);
const time = (iso: string) => iso.slice(11, 19);

function AlertCard({
  alert,
  state,
  name,
  run,
}: {
  alert: Alert;
  state: DeskState;
  name: string;
  run: (p: Promise<DeskState>) => void;
}) {
  const [note, setNote] = useState('');
  const clip = useRef<HTMLVideoElement>(null);
  const high = alert.score >= state.high_score;
  return (
    <div className={`sw-alert ${high ? 'high' : ''}`}>
      <div className="sw-alert-media">
        {alert.clip ? (
          <video
            ref={clip}
            src={alert.clip}
            controls
            muted
            playsInline
            onLoadedMetadata={() => {
              if (clip.current) clip.current.currentTime = alert.clip_start ?? 0;
            }}
          />
        ) : alert.frames ? (
          <div className="sw-frames">
            {alert.frames.map((f, i) => (
              <img key={i} src={f} alt={`Frame ${i + 1} sent to the behaviour model`} />
            ))}
          </div>
        ) : (
          <div className="sw-noclip small muted">Scripted alert: no footage. In a shop, the clip plays here.</div>
        )}
      </div>
      <div className="sw-alert-body">
        <div className="sw-row">
          {alert.thumbnail && <img className="sw-thumb" src={alert.thumbnail} alt="Face captured with this alert" />}
          <b>
            Alert {alert.id} · {who(alert.person)}
          </b>
          <span className={`sw-score ${high ? 'high' : ''}`}>Score {alert.score}</span>
          <span className="small muted">{time(alert.at)}</span>
        </div>
        <div className="sw-row">
          {alert.rules.map((rule) => (
            <span key={rule} className="sw-tag rule">
              {state.rule_words[rule] ?? rule}
            </span>
          ))}
          {alert.source && (
            <span className="sw-tag">{alert.source === 'model' ? 'Checked by the behaviour model' : 'Rules only'}</span>
          )}
          {high && <span className="sw-tag bad">Face held, admin alerted</span>}
        </div>
        <p>{alert.frames || alert.clip ? alert.what : `${alert.what.split('.')[0]}.`}</p>
        {alert.has_face === false && (
          <p className="small sw-error">No face was captured with this alert, so confirming cannot add anyone.</p>
        )}
        <input
          className="sw-note-input"
          placeholder="Note (optional): what you saw"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="sw-row">
          <button
            className="btn primary"
            onClick={() => run(desk.review(alert.id, { reviewer: name, theft: true, note }))}
          >
            Confirm theft · add to watchlist
          </button>
          <button className="btn" onClick={() => run(desk.review(alert.id, { reviewer: name, theft: false, note }))}>
            Not theft
          </button>
        </div>
      </div>
    </div>
  );
}

/** The loss-prevention desk: a live camera with rules and a behaviour model, and the one step that is always a person's. */
export default function StoreWatchPage() {
  const [state, setState] = useState<DeskState | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('Sam Patel');
  const [threshold, setThreshold] = useState(80);
  const [stats, setStats] = useState<LiveStats>({ people: 0, visits: 0 });
  const [doorFaces, setDoorFaces] = useState<Record<number, string>>({});
  const [form, setForm] = useState({ controller: '', lawful_basis: '', dpia_reference: '', signage: true });

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

  if (!state)
    return (
      <main className="page-storewatch">
        <h1>Loss-prevention desk</h1>
        <p className={error ? 'sw-error' : 'muted'}>
          {error ? `${error} This page needs the backend running.` : 'Loading…'}
        </p>
      </main>
    );

  const pending = state.alerts.filter((a) => a.status === 'pending');
  const decided = state.alerts.filter((a) => a.status !== 'pending');
  const confirmed = state.alerts.filter((a) => a.status === 'confirmed').length;
  const open = state.matches.filter((m) => m.status === 'open');
  const closed = state.matches.filter((m) => m.status !== 'open');
  const wrong = closed.filter((m) => m.correct === 0).length;
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(desk.compliance(form));
  };

  return (
    <main className="page-storewatch">
      <div className="kicker">Building · Loss prevention</div>
      <h1>Loss-prevention desk</h1>
      <p className="lede">
        A camera watches the shop floor. Your browser finds each person, their pose and the items in their hands; rules
        in code follow them past the shelf, the till and the exit; and a behaviour model looks at a short burst of
        frames only when the rules raise suspicion. Alerts arrive with a clip. A person decides who goes on the
        watchlist, and the door camera flags them next time.
      </p>
      {error && <p className="sw-error">{error}</p>}

      <div className="sw-stats">
        <div>
          <b>{stats.people}</b>
          <span>in view</span>
        </div>
        <div>
          <b>{stats.visits}</b>
          <span>visits this session</span>
        </div>
        <div className={pending.length ? 'hot' : ''}>
          <b>{pending.length}</b>
          <span>alerts waiting</span>
        </div>
        <div>
          <b>{confirmed}</b>
          <span>confirmed</span>
        </div>
        <div className={open.length ? 'hot' : ''}>
          <b>{state.matches.length}</b>
          <span>door matches</span>
        </div>
        <div>
          <b>{state.watchlist.filter((e) => e.status === 'active').length}</b>
          <span>on the watchlist</span>
        </div>
      </div>

      <div className="sw-layout">
        <LiveDesk
          state={state}
          threshold={threshold}
          onState={setState}
          onError={setError}
          onStats={setStats}
          onDoorFace={(id, face) => setDoorFaces((m) => ({ ...m, [id]: face }))}
        />

        <aside className="sw-side">
          <section className="card">
            <div className="sw-row sw-head">
              <h2>Alerts</h2>
              <label className="sw-name">
                Reviewer <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            {pending.length === 0 && (
              <p className="small muted">
                No alerts waiting. A score of {state.high_score} or more alerts the admin and holds the face; it is
                deleted after {state.hold_hours} hours if nobody reviews it.
              </p>
            )}
            {pending.map((a) => (
              <AlertCard key={a.id} alert={a} state={state} name={name} run={run} />
            ))}
          </section>

          <section className="card">
            <h2>At the door</h2>
            <div className="sw-row">
              <label className="sw-name">
                Match threshold{' '}
                <input
                  type="range"
                  min={60}
                  max={95}
                  value={threshold}
                  onChange={(e) => setThreshold(+e.target.value)}
                />{' '}
                {threshold}
              </label>
              <span className="small muted">Compared and forgotten: {state.visitors_discarded}</span>
            </div>
            {open.length === 0 && (
              <p className="small muted">
                Turn on the door camera under the video. A face that matches nobody on the live watchlist is forgotten
                at once.
              </p>
            )}
            {open.map((m) => (
              <div key={m.id} className={`sw-match ${m.high ? 'high' : ''}`}>
                <div className="sw-faces">
                  <figure>
                    {doorFaces[m.id] ? (
                      <img src={doorFaces[m.id]} alt="The face at the door" />
                    ) : (
                      <div className="sw-blank" />
                    )}
                    <figcaption>At the door</figcaption>
                  </figure>
                  <span className={`sw-score ${m.high ? 'high' : ''}`}>{m.score}</span>
                  <figure>
                    {m.thumbnail ? (
                      <img src={m.thumbnail} alt="The face on the watchlist" />
                    ) : (
                      <div className="sw-blank" />
                    )}
                    <figcaption>{who(m.person)}</figcaption>
                  </figure>
                </div>
                <p className="small muted">A possible match. Look before anyone speaks to this person.</p>
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
            {wrong > 0 && (
              <p className="sw-lesson">
                <b>
                  The camera matched {wrong} innocent look-alike{wrong > 1 ? 's' : ''}.
                </b>{' '}
                That is why a match is only ever a prompt for a person to look.
              </p>
            )}
          </section>
        </aside>
      </div>

      <section className="card sw-step">
        <h2>Watchlist</h2>
        {state.watchlist.length === 0 && <p className="muted small">Empty. Confirming an alert adds its face here.</p>}
        <div className="sw-gallery">
          {state.watchlist.map((e) => (
            <div key={e.id} className={`sw-card ${e.status}`}>
              {e.thumbnail ? <img src={e.thumbnail} alt="The face on this entry" /> : <div className="sw-blank big" />}
              <b>{who(e.person)}</b>
              <span className={`sw-tag ${e.status}`}>{e.status === 'active' ? 'Live' : 'Held: cannot match'}</span>
              <span className="small muted">
                Until {e.expires.slice(0, 10)}
                {e.added_by ? ` · by ${e.added_by}` : ''}
              </span>
              <p className="small" title={e.reason}>
                {e.reason}
              </p>
              <button className="btn small" onClick={() => run(desk.remove(e.id, name, 'Erasure request or mistake'))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      {decided.length > 0 && (
        <section className="card sw-step">
          <h2>Decided alerts</h2>
          <table className="t">
            <thead>
              <tr>
                <th>Alert</th>
                <th>Score</th>
                <th>Rules</th>
                <th>Decision</th>
                <th>By</th>
                <th>Truth (scripted only)</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>{a.score}</td>
                  <td>{a.rules.map((r) => state.rule_words[r] ?? r).join(', ') || '–'}</td>
                  <td>{a.status}</td>
                  <td>{a.reviewer ?? 'nobody'}</td>
                  <td>{a.truth === 'unknown' ? '–' : a.truth}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.high_score_rejected > 0 && (
            <p className="sw-lesson">
              <b>
                A person rejected {state.high_score_rejected} high-score alert{state.high_score_rejected > 1 ? 's' : ''}
                .
              </b>{' '}
              With automatic adding, that person would now be flagged at every visit.
            </p>
          )}
        </section>
      )}

      <section className="card sw-step">
        <h2>No camera? Run the scripted day</h2>
        <p className="small muted">
          Invented shoppers and invented visitors, with the truth revealed once a person has decided, so you can see a
          wrong call.
        </p>
        <div className="sw-row">
          <button className="btn" disabled={!state.more_alerts} onClick={() => run(desk.nextAlert())}>
            {state.more_alerts ? 'Next scripted alert' : 'No more scripted alerts'}
          </button>
          <button className="btn" disabled={!state.more_visitors} onClick={() => run(desk.nextVisitor(threshold))}>
            {state.more_visitors ? 'Next scripted visitor at the door' : 'No more scripted visitors'}
          </button>
        </div>
      </section>

      <details className="card sw-step sw-governance">
        <summary>
          <h2>Governance, retention and the audit log</h2>
        </summary>
        <p className="small">
          This desk runs in demo mode, on your own machine, for people who know they are being filmed. A real shop needs
          a lawful basis and an Article 9 condition for biometric data under UK GDPR, a DPIA, and signs before people
          enter; take legal advice first. What the backend enforces anyway: only a named person can put someone on the
          watchlist, held faces are deleted after {state.hold_hours} hours, live entries after {state.retention_days}{' '}
          days, a face that matches nobody is forgotten, and every action is logged.
        </p>
        {state.compliance ? (
          <p className="small">
            Recorded for <b>{state.compliance.controller}</b>: DPIA {state.compliance.dpia_reference}. Basis:{' '}
            {state.compliance.lawful_basis}
          </p>
        ) : (
          <form className="sw-form" onSubmit={save}>
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
            <button className="btn">Record (optional in demo mode)</button>
          </form>
        )}
        <div className="sw-row">
          <button className="btn small" onClick={() => run(desk.advance(4))}>
            Move the clock 4 days
          </button>
          <button className="btn small" onClick={() => run(desk.advance(30))}>
            Move the clock 30 days
          </button>
          <span className="small muted">Clock: +{state.days_ahead} days.</span>
        </div>
        <h3>Alerts to the admin</h3>
        <ul className="sw-notices">
          {state.notices.map((n) => (
            <li key={n.id} className={n.level}>
              {n.text}
            </li>
          ))}
        </ul>
        <h3>Audit log</h3>
        <ul className="sw-audit">
          {state.audit.map((a) => (
            <li key={a.id}>
              <span className="muted">{a.at.slice(0, 16).replace('T', ' ')}</span> <b>{a.actor}</b>: {a.action}
            </li>
          ))}
        </ul>
        <button className="btn" onClick={() => run(desk.reset())}>
          Start again (deletes every alert, clip and entry)
        </button>
      </details>
    </main>
  );
}
