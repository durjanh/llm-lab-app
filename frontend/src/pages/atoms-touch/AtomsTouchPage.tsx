import { useEffect, useMemo, useRef, useState } from 'react';
import { DURATION, HALVINGS, STAGES, formatLength, scaleBar, stateAt } from './film';
import { Film3D } from './Film3D';
import { FilmFlat } from './FilmFlat';
import { ForceChart } from './ForceChart';
import './atoms-touch.css';

const SPEEDS = [0.5, 1, 2];

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** A short film, drawn by the page: two fingertips close in, the camera follows the gap down to atoms. */
export default function AtomsTouchPage() {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [flat, setFlat] = useState(() => !hasWebGL());
  const last = useRef<number | null>(null);

  // One animation frame at a time while playing; stopped on pause, at the end and when the page closes.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      let ended = false;
      setTime((t) => {
        const next = Math.min(DURATION, t + dt * speed);
        ended = next >= DURATION;
        return next;
      });
      if (ended) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      last.current = null;
    };
  }, [playing, speed]);

  const state = useMemo(() => stateAt(time), [time]);
  const stage = STAGES[state.stage];
  const bar = scaleBar(state.unit, state.pull);

  return (
    <main className="page-atoms-touch">
      <div className="kicker">Foundations · Atoms film</div>
      <h1>Why fingers never quite touch</h1>
      <p className="lede">
        Two fingertips close in. Each time the gap halves, the camera moves in to keep it in view: from millimetres to
        skin ridges, cells, molecules and finally atoms, where the gap stops shrinking and pushes back.
      </p>

      <section className="at-film" aria-label="The film">
        <div className="at-screen">
          {flat ? <FilmFlat state={state} /> : <Film3D state={state} onFail={() => setFlat(true)} />}
          <div className="at-readout" data-testid="readout">
            <div className="at-gap">{formatLength(state.shownGap)}</div>
            <div className="small">
              gap · halved {state.halvings} of {HALVINGS} times
            </div>
          </div>
          <div className="at-stage small">
            {state.stage + 1}. {stage.title} · {stage.scale}
          </div>
          <div className="at-scalebar small">
            <span style={{ width: `${(bar.units / (1.9 * state.pull)) * 100}%` }} />
            {formatLength(bar.metres)}
          </div>
          <p className="at-caption" data-testid="caption">
            {stage.caption}
          </p>
        </div>

        <div className="at-controls">
          <button
            className="btn small primary"
            onClick={() => {
              if (time >= DURATION) setTime(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            className="btn small"
            onClick={() => {
              setTime(0);
              setPlaying(true);
            }}
          >
            Replay
          </button>
          <input
            type="range"
            aria-label="Scrub through the film"
            min={0}
            max={DURATION}
            step={0.05}
            value={time}
            onChange={(e) => {
              setPlaying(false);
              setTime(+e.target.value);
            }}
          />
          <span className="small mono">
            {time.toFixed(1)} / {DURATION} s
          </span>
          <label className="small">
            Speed{' '}
            <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            <input type="checkbox" checked={flat} onChange={(e) => setFlat(e.target.checked)} /> Flat cross-section
          </label>
        </div>
        <ol className="at-chapters small">
          {STAGES.map((s, i) => (
            <li key={s.id}>
              <button className={i === state.stage ? 'on' : ''} onClick={() => setTime(s.from)}>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <div className="at-two">
        <ForceChart state={state} />
        <div>
          <h2>What is really happening</h2>
          <p>
            Atoms are neutral: each nucleus is wrapped in electrons with an equal and opposite charge. So two atoms do
            not push each other apart simply because electrons repel. From a distance they even pull a little, because
            their clouds jostle into step (the dip in the chart).
          </p>
          <p>
            The steep push comes from the <b>Pauli exclusion principle</b>: no two electrons can share the same state.
            When two clouds start to overlap, their electrons have to move into higher-energy states, and that costs so
            much energy that the atoms are forced apart. Electric repulsion is part of the bill, but Pauli is why the
            wall is so steep.
          </p>
          <p>
            Pressed atoms settle a few tenths of a nanometre apart, centre to centre. Whether that counts as “not
            touching” is a matter of definition: at this scale, that push <i>is</i> what touching means. You feel it
            because nerves in your skin sense the skin bending under the push.
          </p>
        </div>
      </div>

      <h2>What is simplified</h2>
      <ul className="small">
        <li>Electron clouds are drawn as soft shells. Real clouds have no edge; they thin out.</li>
        <li>
          Real skin is rough, oily and wet. Fingertips meet first at a few ridge crests, through a film of sweat and
          sebum, so real contact is mostly molecules of oil against each other.
        </li>
        <li>
          The cells, fat molecules and atoms are idealised: neat rows, one kind of atom, held still apart from a shiver.
        </li>
        <li>
          The force curve is a Lennard-Jones model with illustrative numbers, set so the resting gap is 298 pm. Real
          contacts involve many atoms at once and electric charges on the surfaces.
        </li>
        <li>Nuclei are drawn much too large: at true scale they would be 100,000 times smaller than the cloud.</li>
      </ul>
      <p className="small muted">
        Who made this: the scene is code written by a model (Claude). Nothing is a video or a pre-rendered image: every
        frame, the gap readout and the force chart are computed by this page as it plays.
      </p>
    </main>
  );
}
