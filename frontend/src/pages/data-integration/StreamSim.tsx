import { useState } from 'react';
import {
  CHUNKS_PER_DOC,
  crash,
  finished,
  initStream,
  replayAll,
  report,
  restart,
  step,
  type StreamOptions,
} from './stream';

const START: StreamOptions = { keyed: true, idempotent: false, deadLetter: false, checkpointEvery: 3 };

/** Document-change events through three partitions into a vector index, with a crash button. */
export function StreamSim() {
  const [opts, setOpts] = useState<StreamOptions>(START);
  const [s, setS] = useState(() => initStream(START));
  const rep = report(s);
  const done = finished(s);

  const change = (next: StreamOptions) => {
    setOpts(next);
    setS(initStream(next));
  };
  const runToEnd = () => {
    let t = s;
    // A blocked partition never finishes, so stop after enough ticks to show it.
    for (let i = 0; i < 12 && !finished(t); i++) t = step(t, opts);
    setS(t);
  };

  return (
    <div className="card di-demo">
      <div className="chips di-switches">
        {(
          [
            ['keyed', 'Partition key: document id'],
            ['idempotent', 'Idempotent consumer'],
            ['deadLetter', 'Dead-letter queue'],
          ] as [keyof StreamOptions, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={opts[key] ? 'chip-btn on' : 'chip-btn'}
            aria-pressed={!!opts[key]}
            onClick={() => change({ ...opts, [key]: !opts[key] })}
          >
            {label}
          </button>
        ))}
        <label className="di-inline">
          Checkpoint every{' '}
          <select value={opts.checkpointEvery} onChange={(e) => change({ ...opts, checkpointEvery: +e.target.value })}>
            <option value={1}>event</option>
            <option value={3}>3 events</option>
            <option value={5}>5 events</option>
          </select>
        </label>
      </div>

      <div className="row di-controls">
        <button type="button" className="btn primary" disabled={s.crashed || done} onClick={() => setS(step(s, opts))}>
          Next tick
        </button>
        <button type="button" className="btn" disabled={s.crashed || done} onClick={runToEnd}>
          Run on
        </button>
        <button type="button" className="btn" disabled={s.crashed || done} onClick={() => setS(crash(s))}>
          Crash the consumer
        </button>
        <button type="button" className="btn" disabled={!s.crashed} onClick={() => setS(restart(s))}>
          Restart it
        </button>
        <button type="button" className="btn" disabled={s.crashed} onClick={() => setS(replayAll(s))}>
          Replay from offset 0
        </button>
        <button type="button" className="btn" onClick={() => change(opts)}>
          Start again
        </button>
      </div>

      <div className="di-lanes" aria-label="Partitions">
        {s.partitions.map((events, p) => (
          <div key={p} className="di-lane">
            <span className="di-lane-name">P{p}</span>
            <div className="di-lane-events">
              {events.map((e, i) => {
                const cls = [
                  'di-ev',
                  i < s.position[p] ? 'read' : '',
                  i === s.position[p] && !s.crashed ? 'next' : '',
                  e.poison ? 'poison' : '',
                  i === s.checkpoint[p] ? 'ckpt' : '',
                ].join(' ');
                return (
                  <span key={e.id} className={cls} title={`${e.id}: ${e.title} v${e.version}`}>
                    {e.doc}
                    <sub>v{e.version}</sub>
                  </span>
                );
              })}
              {s.checkpoint[p] === events.length && <span className="di-ev ckpt end" aria-hidden />}
            </div>
          </div>
        ))}
        <p className="small muted">
          Grey: read. Outlined: next. The bar marks the committed checkpoint, where a restarted consumer begins.
          {s.crashed && <b className="di-bad"> The consumer is down.</b>}
        </p>
      </div>

      <div className="stats" aria-live="polite">
        <div className="stat">
          <div className="v">{s.embedCalls}</div>
          <div className="k">embedding calls (paid)</div>
        </div>
        <div className="stat">
          <div className="v">{rep.duplicateChunks}</div>
          <div className="k">duplicate chunks in the index</div>
        </div>
        <div className="stat">
          <div className="v">{rep.stale.length ? rep.stale.join(', ') : '0'}</div>
          <div className="k">documents left on an older version</div>
        </div>
        <div className="stat">
          <div className="v">{s.deadLetters.length}</div>
          <div className="k">{rep.blocked ? 'dead-lettered · a partition is stuck' : 'dead-lettered'}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="table-wrap">
          <table className="t di-small">
            <thead>
              <tr>
                <th>Document</th>
                <th className="num">Version</th>
                <th className="num">Chunks</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(s.index)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([doc, v]) => (
                  <tr key={doc}>
                    <td>{doc}</td>
                    <td className={rep.stale.includes(doc) ? 'num di-bad' : 'num'}>{v.version}</td>
                    <td className={v.chunks > CHUNKS_PER_DOC ? 'num di-bad' : 'num'}>{v.chunks}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <ol className="di-log small" aria-label="Consumer log">
          {s.log.slice(-10).map((l, i) => (
            <li key={`${s.log.length}-${i}`}>{l}</li>
          ))}
          {s.log.length === 0 && <li className="muted">Press Next tick.</li>}
        </ol>
      </div>
    </div>
  );
}
