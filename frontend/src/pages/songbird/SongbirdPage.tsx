import { useCallback, useEffect, useRef, useState } from 'react';
import { modelName } from '@/lib/models';
import { songbirdService, type ComposedSong } from '@/services/songbirdService';
import { statusService } from '@/services/statusService';
import { Bird, type BirdHandle } from './Bird';
import { Spectrogram, type SpectrogramHandle } from './Spectrogram';
import { SONGS, SYNTH_PALETTE, songLength, type Song } from './songs';
import { DEFAULT_CONTROLS, SPLIT_HZ, SyrinxSynth, tubeResonances, type Controls, type PlayMode } from './synth';
import './songbird.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The keyboard: white keys on the home row, black keys above, like a piano laid on the letters.
const KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';'];
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const freqOf = (octave: number, semitone: number) => 440 * Math.pow(2, (12 * (octave + 1) + semitone - 69) / 12);

const TIMBRES: { name: string; controls: Partial<Controls>; mode?: PlayMode }[] = [
  { name: 'Glass flute', controls: { grit: 0.04, wah: 0.75, lfoDepth: 0.006, lfoRate: 5, glideMs: 30 } },
  { name: 'Buzzy finch', controls: { grit: 0.95, wah: 0.25, lfoDepth: 0, glideMs: 10 } },
  { name: 'Warbler', controls: { grit: 0.15, wah: 0.6, lfoDepth: 0.035, lfoRate: 13, glideMs: 60 } },
  { name: 'Canary roll', controls: { grit: 0.3, wah: 0.8, lfoDepth: 0.06, lfoRate: 22, glideMs: 25 } },
  { name: 'Two-voice ring', controls: { grit: 0.2, wah: 0.5, detuneCents: 35, lfoDepth: 0.01 }, mode: 'both' },
  { name: 'Robot bird', controls: { grit: 0.65, wah: 0.9, detuneCents: 12, lfoDepth: 0.02, lfoRate: 30 } },
];

const SLIDERS: {
  key: keyof Controls;
  label: string;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
}[] = [
  { key: 'breath', label: 'Breath', min: 0, max: 1, step: 0.01, show: (v) => `${(0.4 + v * 1.6).toFixed(2)} kPa` },
  { key: 'glideMs', label: 'Glide', min: 0, max: 300, step: 1, show: (v) => `${v} ms` },
  { key: 'detuneCents', label: 'Detune', min: 0, max: 60, step: 1, show: (v) => `${v} ct` },
  { key: 'grit', label: 'Membrane grit', min: 0, max: 1, step: 0.01, show: (v) => `${Math.round(v * 100)}%` },
  { key: 'tubeMm', label: 'Windpipe length', min: 20, max: 70, step: 1, show: (v) => `${v} mm` },
  { key: 'wah', label: 'Throat chamber', min: 0, max: 1, step: 0.01, show: (v) => `${Math.round(v * 100)}%` },
  { key: 'lfoRate', label: 'Warble rate', min: 1, max: 40, step: 0.5, show: (v) => `${v} Hz` },
  { key: 'lfoDepth', label: 'Warble depth', min: 0, max: 0.08, step: 0.001, show: (v) => `${(v * 100).toFixed(1)}%` },
];

const IDEAS = [
  'Three slow rising whistles, then a fast descending trill',
  'A duet: a low steady note on the left with a high warbling note on the right',
  'Like a cardinal: sweeping down from very high to low, handed between the sides, five times',
  'A short buzzy call, repeated with a quickening rhythm',
];

/** A songbird's two-voice syrinx, drawn in cutaway and synthesised live: seven songs, a playable bird, and a composer. */
export default function SongbirdPage() {
  const synth = useRef<SyrinxSynth | null>(null);
  const bird = useRef<BirdHandle>(null);
  const spectro = useRef<SpectrogramHandle>(null);
  const [selected, setSelected] = useState<Song | 'synth'>(SONGS[1]);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [mode, setMode] = useState<PlayMode>('duo');
  const [octave, setOctave] = useState(6);
  const [hold, setHold] = useState(false);
  const [held, setHeld] = useState<number | null>(null);
  const [timbre, setTimbre] = useState(TIMBRES[0].name);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [idea, setIdea] = useState(IDEAS[0]);
  const [busy, setBusy] = useState(false);
  const [composed, setComposed] = useState<(ComposedSong & { song: Song }) | null>(null);
  const [cost, setCost] = useState(0);

  /** The synth starts on the first press: browsers only allow sound after a click or a key. */
  const ensure = useCallback(async () => {
    if (!synth.current) {
      synth.current = new SyrinxSynth();
      synth.current.setControls(controls);
    }
    await synth.current.resume();
    return synth.current;
  }, [controls]);

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => undefined);
  }, []);

  // One animation loop drives the drawing and the spectrogram from what the synth is doing.
  useEffect(() => {
    let frame = 0;
    let lastProgress = -1;
    let wasPlaying = false;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const s = synth.current;
      const state = s ? s.state() : { L: { freq: 0, amp: 0 }, R: { freq: 0, amp: 0 }, playing: false, progress: 0 };
      bird.current?.update(state, now / 1000, s?.getControls().tubeMm ?? DEFAULT_CONTROLS.tubeMm);
      if (s) spectro.current?.draw(s.analyser, true);
      if (Math.abs(state.progress - lastProgress) > 0.01) {
        lastProgress = state.progress;
        setProgress(state.progress);
      }
      if (state.playing !== wasPlaying) {
        wasPlaying = state.playing;
        setPlaying(state.playing);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      synth.current?.close();
      synth.current = null;
    };
  }, []);

  useEffect(() => synth.current?.setControls(controls), [controls]);

  async function play(song: Song) {
    setSelected(song);
    setError('');
    try {
      const s = await ensure();
      s.play(song.notes);
    } catch (err) {
      setError(`Sound could not start: ${errorText(err)}`);
    }
  }

  function stop() {
    synth.current?.stop();
    setHeld(null);
  }

  // The playable bird's keyboard: keys held down sing; Z and X change octave; space toggles hold.
  const press = useCallback(
    async (index: number) => {
      const s = await ensure();
      s.noteOn(freqOf(octave, index), mode);
      setHeld(index);
    },
    [ensure, octave, mode],
  );
  const release = useCallback(() => {
    if (hold) return;
    synth.current?.noteOff();
    setHeld(null);
  }, [hold]);

  useEffect(() => {
    if (selected !== 'synth') return;
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.repeat || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z') setOctave((o) => Math.max(5, o - 1));
      else if (k === 'x') setOctave((o) => Math.min(8, o + 1));
      else if (k === ' ') {
        e.preventDefault();
        setHold((h) => {
          if (h) synth.current?.noteOff();
          return !h;
        });
      } else if (KEYS.includes(k)) {
        e.preventDefault();
        void press(KEYS.indexOf(k));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (!typing(e) && KEYS.includes(e.key.toLowerCase())) release();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [selected, press, release]);

  async function compose() {
    setBusy(true);
    setError('');
    try {
      const r = await songbirdService.compose(idea.trim(), model);
      const song: Song = {
        id: 'composed',
        name: r.title,
        style: `Composed by ${modelName(r.model)}`,
        about: r.explanation,
        palette: { body: '#5f8a6e', wing: '#4a7058', belly: '#e3eadf', beak: '#d2a35f' },
        notes: r.notes,
      };
      setComposed({ ...r, song });
      setCost((c) => c + r.cost_usd);
      void play(song);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const song = selected === 'synth' ? null : selected;
  const palette = song ? song.palette : SYNTH_PALETTE;
  const [tube1, tube2] = tubeResonances(controls.tubeMm);

  return (
    <main className="page-songbird">
      <div className="kicker">Building · Songbird</div>
      <h1>How a songbird sings two notes at once</h1>
      <p className="lede">
        A songbird’s voice box, the syrinx, sits deep in its chest where the windpipe splits in two, and each side has
        its own vibrating folds. So a bird has two voices: it can sing two notes at the same time, or hand one sweep
        from side to side. Pick a bird to hear a stylised version of its song, synthesised live in your browser from
        that anatomy, and watch which side is singing.
      </p>
      {error && <p className="sb-bad small">{error}</p>}

      <div className="sb-stage">
        <aside className="sb-birds">
          <button
            className="btn small sb-stop"
            onClick={() => (playing ? stop() : song && void play(song))}
            disabled={!song && !playing}
          >
            {playing ? '■ Stop' : '▶ Play song'}
          </button>
          {[...SONGS, ...(composed ? [composed.song] : [])].map((s) => (
            <button key={s.id} className={`sb-bird-btn${song?.id === s.id ? ' on' : ''}`} onClick={() => void play(s)}>
              <span className="sb-swatch" style={{ background: s.palette.body }} />
              <span>
                <b>{s.name}</b>
                <i>{s.style}</i>
              </span>
            </button>
          ))}
          <button
            className={`sb-bird-btn${selected === 'synth' ? ' on' : ''}`}
            onClick={() => {
              stop();
              setSelected('synth');
            }}
          >
            <span className="sb-swatch" style={{ background: SYNTH_PALETTE.body }} />
            <span>
              <b>SynthBird</b>
              <i>Play the syrinx yourself</i>
            </span>
          </button>
        </aside>

        <div className="sb-centre">
          <Bird ref={bird} palette={palette} />
          {song && (
            <p className="small sb-about">
              <b>{song.name}.</b> {song.about}{' '}
              <span className="muted">
                {song.notes.length} notes, {songLength(song.notes).toFixed(1)} s.
              </span>
            </p>
          )}
          {song && playing && (
            <div className="sb-progress">
              <i style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>

        {selected === 'synth' && (
          <aside className="sb-synth">
            <div className="sb-timbres">
              {TIMBRES.map((t) => (
                <button
                  key={t.name}
                  className={`sb-chip${timbre === t.name ? ' on' : ''}`}
                  onClick={() => {
                    setTimbre(t.name);
                    setControls((c) => ({ ...c, ...t.controls }));
                    if (t.mode) setMode(t.mode);
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <div className="sb-modes">
              {(['duo', 'left', 'right', 'both'] as PlayMode[]).map((m) => (
                <button
                  key={m}
                  className={`sb-chip${mode === m ? ' on' : ''}`}
                  onClick={() => setMode(m)}
                  title={
                    m === 'duo'
                      ? `Notes below ${SPLIT_HZ / 1000} kHz on the left side, above on the right`
                      : m === 'both'
                        ? 'Both sides on every note, detuned'
                        : `Only the ${m} side`
                  }
                >
                  {m}
                </button>
              ))}
              <button className={`sb-chip${hold ? ' on' : ''}`} onClick={() => setHold((h) => !h)}>
                hold
              </button>
              <span className="sb-oct">
                <button className="sb-chip" onClick={() => setOctave((o) => Math.max(5, o - 1))}>
                  −
                </button>
                oct {octave}
                <button className="sb-chip" onClick={() => setOctave((o) => Math.min(8, o + 1))}>
                  +
                </button>
              </span>
            </div>
            <div className="sb-sliders">
              {SLIDERS.map((sl) => (
                <label key={sl.key}>
                  <span>
                    {sl.label} <b>{sl.show(controls[sl.key])}</b>
                  </span>
                  <input
                    type="range"
                    min={sl.min}
                    max={sl.max}
                    step={sl.step}
                    value={controls[sl.key]}
                    onChange={(e) => setControls((c) => ({ ...c, [sl.key]: Number(e.target.value) }))}
                  />
                </label>
              ))}
            </div>
            <p className="small muted">
              Windpipe resonances: {(tube1 / 1000).toFixed(1)} and {(tube2 / 1000).toFixed(1)} kHz (a tube closed at one
              end resonates at odd quarter-wavelengths).
            </p>
            <div className="sb-keys" onPointerUp={release} onPointerLeave={release}>
              {KEYS.map((k, i) => {
                const black = [1, 3, 6, 8, 10, 13, 15].includes(i);
                const f = freqOf(octave, i);
                const side =
                  mode === 'duo' ? (f < SPLIT_HZ ? 'L' : 'R') : mode === 'left' ? 'L' : mode === 'right' ? 'R' : 'LR';
                return (
                  <button
                    key={k}
                    className={`sb-key${black ? ' black' : ''}${held === i ? ' down' : ''} side-${side}`}
                    onPointerDown={() => void press(i)}
                    title={`${NAMES[i % 12]}${octave + Math.floor(i / 12)} · ${Math.round(f)} Hz`}
                  >
                    <span>{k.toUpperCase()}</span>
                  </button>
                );
              })}
            </div>
            <p className="small muted">
              Keys A to ; play (black keys W E T Y U O P). Z / X change octave, space toggles hold. Blue keys sing on
              the left side, orange on the right.
            </p>
          </aside>
        )}
      </div>

      <Spectrogram ref={spectro} />

      <section className="card sb-compose">
        <h2>Compose a song with a model</h2>
        <p className="small">
          Describe a song. The model writes it as notes for the two sides of the syrinx; code checks every note is in
          that side’s range, that no side sings two notes at once and that the song is short, and sends any problems
          back once before the synth plays it.
        </p>
        <div className="sb-ideas">
          {IDEAS.map((i) => (
            <button key={i} className="btn small" onClick={() => setIdea(i)} disabled={busy}>
              {i}
            </button>
          ))}
        </div>
        <div className="sb-row">
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={2} maxLength={600} />
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={busy || idea.trim().length < 3 || !model}
            onClick={() => void compose()}
          >
            {busy ? 'Composing…' : 'Compose and play'}
          </button>
        </div>
        {composed && (
          <div className="sb-composed small">
            <p>
              <b>{composed.title}</b>: {composed.notes.length} notes, {songLength(composed.notes).toFixed(1)} s, by{' '}
              {composed.model}. {composed.explanation}
            </p>
            {composed.tries.length > 1 && (
              <p className="muted">
                The first score could not be sung ({composed.tries[0].problems.slice(0, 2).join(' ')}); the model fixed
                it on the second try.
              </p>
            )}
            <p className="muted">Model calls on this page: ${cost.toFixed(4)}</p>
          </div>
        )}
      </section>

      <h2>What the parts do</h2>
      <ul className="sb-facts">
        <li>
          <b>Two voices.</b> The syrinx sits where the windpipe divides into the two bronchi. Each side has its own
          folds (labia) and its own muscles, controlled by its own nerve, so the sides can sing different notes, or one
          can stay silent while the other sings.
        </li>
        <li>
          <b>Left low, right high.</b> In many songbirds the left side sings lower notes and the right side higher ones.
          Cardinals hand long sweeps across at about 3 kHz without a break you can hear.
        </li>
        <li>
          <b>Breath.</b> Air sacs through the body push air past the folds. Between syllables birds take mini-breaths,
          up to 30 a second in fast trills.
        </li>
        <li>
          <b>The filter.</b> The windpipe resonates like a tube, the throat chamber swells to tune itself to each note,
          and the beak opens wider for higher notes. Together they strip out the harmonics, which is why many birds
          sound like pure whistles even though the folds make buzz.
        </li>
        <li>
          <b>What is real here.</b> The synth follows this signal path, but the songs are stylised scores, not
          recordings, and the drawing is a diagram, not an anatomical model.
        </li>
      </ul>
    </main>
  );
}
