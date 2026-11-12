import { useEffect, useRef, useState } from 'react';
import {
  ClickDetector,
  DwellDetector,
  NINE,
  PointFilter,
  TESTS,
  applyMapping,
  fitMapping,
  thresholdFrom,
  type Mapping,
  type Point,
  type Sample,
} from './gaze';
import { createTracker, type FaceFrame, type Tracker } from './tracker';
import './gaze-pointer.css';

type Source = 'none' | 'loading' | 'camera' | 'mouse';
type Stage = 'ready' | 'calibrate' | 'click' | 'test' | 'practice' | 'done';
type Method = 'jaw' | 'press' | 'blink' | 'dwell';

const METHODS: Record<Method, { label: string; act: string; holdMs: number }> = {
  jaw: { label: 'Open the jaw', act: 'open your jaw wide, then close it', holdMs: 120 },
  press: { label: 'Clench (press the lips together)', act: 'clench and press your lips together firmly', holdMs: 150 },
  blink: { label: 'Long blink (both eyes)', act: 'close both eyes for about half a second', holdMs: 450 },
  dwell: { label: 'Dwell (keep the pointer still)', act: 'keep the pointer still on a target', holdMs: 0 },
};

// Steadiness 1 to 5: the One Euro filter's minimum cut-off. Lower is steadier but slower to follow.
const STEADY = [3, 1.6, 0.9, 0.5, 0.25];
const TARGETS = 8;
const TARGET_RADIUS = 0.06; // of the practice area's width
const SETTLE_MS = 700;
const GATHER_MS = 1000;

const mean = (rows: number[][]) => rows[0].map((_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);
const jitter = () => (Math.random() - 0.5) * 2;

/** The mouse demo's stand-in for a person's eyes: features that depend on where the mouse is, distorted and noisy,
 *  so calibration has a real mapping to find. */
function pretendFeatures([u, v]: Point): number[] {
  const n = 0.003;
  return [
    0.25 * (u - 0.5) + 0.03 * (v - 0.5) + n * jitter(),
    0.18 * (v - 0.5) - 0.02 * (u - 0.5) + n * jitter(),
    0.1 * (u - 0.5) + n * jitter(),
    0.05 * (v - 0.5) + n * jitter(),
  ];
}

function signalOf(method: Method, scores: Record<string, number>): number {
  if (method === 'jaw') return scores.jawOpen ?? 0;
  if (method === 'press') return Math.max(scores.mouthPressLeft ?? 0, scores.mouthPressRight ?? 0);
  if (method === 'blink') return Math.min(scores.eyeBlinkLeft ?? 0, scores.eyeBlinkRight ?? 0);
  return 0;
}

interface Session {
  tracker: Tracker | null;
  stream: MediaStream | null;
  mouse: Point;
  pressed: boolean;
  mapping: Mapping | null;
  filter: PointFilter;
  click: ClickDetector;
  dwell: DwellDetector;
  samples: Sample[];
  gather: number[][];
  idx: number;
  phaseStart: number;
  clickPhase: 'rest' | 'act';
  rest: number[];
  action: number[];
  errors: number[];
  target: Point | null;
  targetSince: number;
  times: number[];
  misses: number;
  smooth: Point | null;
}

const newSession = (): Session => ({
  tracker: null,
  stream: null,
  mouse: [0.5, 0.5],
  pressed: false,
  mapping: null,
  filter: new PointFilter(STEADY[2], 0.02),
  click: new ClickDetector({ threshold: 0.5, holdMs: 120, releaseRatio: 0.7, refractoryMs: 400 }),
  dwell: new DwellDetector(TARGET_RADIUS * 0.6, 1000),
  samples: [],
  gather: [],
  idx: 0,
  phaseStart: 0,
  clickPhase: 'rest',
  rest: [],
  action: [],
  errors: [],
  target: null,
  targetSince: 0,
  times: [],
  misses: 0,
  smooth: null,
});

const randomTarget = (): Point => [0.12 + Math.random() * 0.76, 0.15 + Math.random() * 0.7];

/** A hands-free pointer: the camera follows the eyes and head to move a pointer, and a face movement clicks. */
export default function GazePointerPage() {
  const [source, setSource] = useState<Source>('none');
  const [stage, setStageState] = useState<Stage>('ready');
  const [method, setMethod] = useState<Method>('jaw');
  const [steady, setSteady] = useState(3);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [clickInfo, setClickInfo] = useState<{ threshold: number; restTop: number; peak: number } | null>(null);
  const [results, setResults] = useState<{ hits: number; misses: number; meanMs: number } | null>(null);

  const video = useRef<HTMLVideoElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const rawDot = useRef<HTMLDivElement>(null);
  const smoothDot = useRef<HTMLDivElement>(null);
  const targetDot = useRef<HTMLDivElement>(null);
  const meterFill = useRef<HTMLDivElement>(null);
  const meterLine = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const session = useRef<Session>(newSession());
  const stageRef = useRef<Stage>('ready');
  const methodRef = useRef<Method>('jaw');
  const statusRef = useRef('');
  const mounted = useRef(true);

  const setStage = (s: Stage) => {
    stageRef.current = s;
    setStageState(s);
  };
  const say = (text: string) => {
    if (statusRef.current !== text) {
      statusRef.current = text;
      setStatus(text);
    }
  };

  useEffect(() => {
    methodRef.current = method;
    session.current.click.options.holdMs = METHODS[method].holdMs;
  }, [method]);
  useEffect(() => session.current.filter.tune(STEADY[steady - 1], 0.02), [steady]);

  // The camera and the model are let go when the page closes.
  useEffect(
    () => () => {
      mounted.current = false;
      const s = session.current;
      s.stream?.getTracks().forEach((t) => t.stop());
      s.tracker?.close();
    },
    [],
  );

  // The mouse demo: the space bar (or holding the mouse button) stands in for the face movement.
  useEffect(() => {
    if (source !== 'mouse') return;
    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, select, textarea, button')) return;
      e.preventDefault();
      session.current.pressed = down;
    };
    const down = key(true);
    const up = key(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [source]);

  // The loop: one frame of input, the stage's work, then the pointer, target and meter are moved directly.
  useEffect(() => {
    if (source !== 'camera' && source !== 'mouse') return;
    let frame = 0;
    const place = (el: HTMLElement | null, p: Point | null, w: number, h: number) => {
      if (!el) return;
      el.style.display = p ? 'block' : 'none';
      if (p) el.style.transform = `translate(${p[0] * w}px, ${p[1] * h}px)`;
    };
    const drawPreview = (f: FaceFrame | null) => {
      const c = preview.current;
      const ctx = c?.getContext('2d');
      const v = video.current;
      if (!c || !ctx || !v) return;
      ctx.save();
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1); // a mirror, as people expect to see themselves
      ctx.drawImage(v, 0, 0, c.width, c.height);
      for (const p of f?.points ?? []) {
        ctx.fillStyle = p.kind === 'iris' ? '#22d3ee' : p.kind === 'nose' ? '#f472b6' : '#facc15';
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, p.kind === 'iris' ? 3 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      const s = session.current;
      const el = area.current;
      if (!el) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const m = methodRef.current;
      let features: number[];
      let signal: number;
      if (source === 'camera') {
        let f: FaceFrame | null = null;
        try {
          f = s.tracker && video.current ? s.tracker.detect(video.current, t) : null;
        } catch (err) {
          // The tracker failed on a frame (no WebGL, or the graphics context was lost): stop, and offer the mouse.
          cancelAnimationFrame(frame);
          s.stream?.getTracks().forEach((tr) => tr.stop());
          s.tracker?.close();
          s.stream = null;
          s.tracker = null;
          setError(
            `The face tracker stopped: ${err instanceof Error ? err.message : String(err)}. ` +
              'You can try every step with the mouse instead.',
          );
          setSource('none');
          return;
        }
        drawPreview(f);
        if (!f) {
          say('No face found: face the camera, in even light.');
          return;
        }
        features = f.features;
        signal = signalOf(m, f.scores);
      } else {
        features = pretendFeatures(s.mouse);
        signal = m === 'dwell' ? 0 : s.pressed ? 0.75 + 0.05 * jitter() : 0.06 + 0.03 * Math.abs(jitter());
      }

      const stage = stageRef.current;
      let shown: Point | null = null; // the calibration or test dot

      // The pointer, from the fitted mapping, steadied. A long blink freezes it, as the eyes move while they close.
      const raw = s.mapping ? applyMapping(s.mapping, features) : null;
      const frozen = m === 'blink' && s.smooth && signal > s.click.options.threshold * 0.5;
      if (raw && !frozen) s.smooth = s.filter.filter(raw, t);
      const pointer = s.mapping ? s.smooth : null;

      if (stage === 'calibrate') {
        const target = NINE[s.idx];
        shown = target;
        const dt = t - s.phaseStart;
        if (dt > SETTLE_MS) s.gather.push(features);
        targetDot.current?.style.setProperty('--fill', String(Math.max(0, Math.min(1, (dt - SETTLE_MS) / GATHER_MS))));
        say(`Look at the dot (${s.idx + 1} of ${NINE.length}) and keep your head still.`);
        if (dt >= SETTLE_MS + GATHER_MS) {
          s.samples.push({ target, features: mean(s.gather) });
          s.gather = [];
          s.idx += 1;
          s.phaseStart = t;
          if (s.idx === NINE.length) {
            s.mapping = fitMapping(s.samples);
            s.filter.reset();
            s.smooth = null;
            s.idx = 0;
            s.clickPhase = 'rest';
            s.rest = [];
            s.action = [];
            setStage(m === 'dwell' ? 'test' : 'click');
          }
        }
      } else if (stage === 'click') {
        const dt = t - s.phaseStart;
        if (s.clickPhase === 'rest') {
          say('Relax your face and look at the middle of the area.');
          s.rest.push(signal);
          if (dt > 2500) {
            s.clickPhase = 'act';
            s.phaseStart = t;
          }
        } else {
          say(`Now ${METHODS[m].act}, three times, slowly.`);
          s.action.push(signal);
          if (dt > 5000) {
            const th = thresholdFrom(s.rest, s.action);
            if (th.ok) {
              s.click.options.threshold = th.threshold;
              setClickInfo(th);
              setNote('');
              s.idx = 0;
              s.errors = [];
              s.phaseStart = t;
              setStage('test');
            } else {
              setNote('The camera could not tell your click from resting. Make the movement bigger, and try again.');
              s.clickPhase = 'rest';
              s.rest = [];
              s.action = [];
              s.phaseStart = t;
            }
          }
        }
      } else if (stage === 'test') {
        const target = TESTS[s.idx];
        shown = target;
        const dt = t - s.phaseStart;
        targetDot.current?.style.setProperty('--fill', String(Math.max(0, Math.min(1, (dt - 800) / GATHER_MS))));
        say(`Accuracy check: look at the dot (${s.idx + 1} of ${TESTS.length}).`);
        if (dt > 800 && pointer) s.errors.push(Math.hypot((pointer[0] - target[0]) * W, (pointer[1] - target[1]) * H));
        if (dt >= 800 + GATHER_MS) {
          s.idx += 1;
          s.phaseStart = t;
          if (s.idx === TESTS.length) {
            setAccuracy(s.errors.length ? s.errors.reduce((a, b) => a + b, 0) / s.errors.length : null);
            s.target = randomTarget();
            s.targetSince = t;
            s.times = [];
            s.misses = 0;
            s.click.reset();
            s.dwell.reset();
            setStage('practice');
          }
        }
      }

      // Clicks count in practice and free play.
      let clicked = false;
      if (pointer && (stage === 'practice' || stage === 'ready' || stage === 'done')) {
        clicked = m === 'dwell' ? s.dwell.update(pointer, t) : s.click.update(signal, t);
      }
      if (clicked && pointer && flash.current) {
        flash.current.style.transform = `translate(${pointer[0] * W}px, ${pointer[1] * H}px)`;
        flash.current.classList.remove('go');
        void flash.current.offsetWidth; // restart the ripple
        flash.current.classList.add('go');
      }
      if (stage === 'practice' && s.target) {
        shown = s.target;
        say(`Point at the target and click (${s.times.length + 1} of ${TARGETS}).`);
        if (clicked && pointer) {
          const hit = Math.hypot((pointer[0] - s.target[0]) * W, (pointer[1] - s.target[1]) * H) <= TARGET_RADIUS * W;
          if (hit) {
            s.times.push(t - s.targetSince);
            s.target = randomTarget();
            s.targetSince = t;
            s.dwell.reset();
            if (s.times.length === TARGETS) {
              setResults({
                hits: TARGETS,
                misses: s.misses,
                meanMs: s.times.reduce((a, b) => a + b, 0) / s.times.length,
              });
              s.target = null;
              setStage('done');
            }
          } else s.misses += 1;
        }
      }
      if (stage === 'ready' || stage === 'done') {
        say(s.mapping ? 'Free play: move the pointer and click anywhere.' : 'Press Calibrate to begin.');
      }

      place(targetDot.current, shown, W, H);
      if (targetDot.current) {
        targetDot.current.classList.toggle('practice', stage === 'practice');
        targetDot.current.style.setProperty('--size', `${stage === 'practice' ? TARGET_RADIUS * 2 * W : 28}px`);
      }
      place(rawDot.current, raw, W, H);
      place(smoothDot.current, pointer, W, H);

      // The meter: the click signal against the person's threshold, or the dwell timer.
      const level = m === 'dwell' ? s.dwell.progress(t) : signal;
      if (meterFill.current) {
        meterFill.current.style.width = `${Math.min(1, level) * 100}%`;
        meterFill.current.classList.toggle('over', m === 'dwell' ? level >= 1 : signal >= s.click.options.threshold);
      }
      if (meterLine.current) meterLine.current.style.left = `${(m === 'dwell' ? 1 : s.click.options.threshold) * 100}%`;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [source]);

  async function startCamera() {
    setError('');
    setSource('loading');
    const s = session.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not give pages a camera.');
      const gl = document.createElement('canvas');
      if (!gl.getContext('webgl2') && !gl.getContext('webgl')) {
        throw new Error('The face model needs WebGL, which this browser has turned off.');
      }
      // The model downloads while the person answers the camera prompt; a failure is reported once it is needed.
      const loading = createTracker();
      loading.catch(() => undefined);
      s.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      s.tracker = await loading;
      if (!mounted.current) {
        s.stream.getTracks().forEach((t) => t.stop());
        s.tracker.close();
        return;
      }
      const stream = s.stream;
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play();
      }
      setSource('camera');
    } catch (err) {
      s.stream?.getTracks().forEach((t) => t.stop());
      s.stream = null;
      setSource('none');
      setError(
        `The camera tracker could not start: ${err instanceof Error ? err.message : String(err)} ` +
          'You can try every step with the mouse instead.',
      );
    }
  }

  function startMouse() {
    setError('');
    setSource('mouse');
  }

  function calibrate() {
    const s = session.current;
    s.samples = [];
    s.gather = [];
    s.idx = 0;
    s.mapping = null;
    s.smooth = null;
    s.filter.reset();
    s.click.reset();
    s.phaseStart = performance.now();
    setAccuracy(null);
    setClickInfo(null);
    setResults(null);
    setNote('');
    setStage('calibrate');
  }

  function practiseAgain() {
    const s = session.current;
    s.target = randomTarget();
    s.targetSince = performance.now();
    s.times = [];
    s.misses = 0;
    s.click.reset();
    s.dwell.reset();
    setResults(null);
    setStage('practice');
  }

  const running = source === 'camera' || source === 'mouse';
  const busy = stage === 'calibrate' || stage === 'click' || stage === 'test';

  return (
    <main className="page-gaze-pointer">
      <div className="kicker">Building · Hands-free pointer</div>
      <h1>Point with your eyes, click with your face</h1>
      <p className="lede">
        The camera follows your eyes and head, and a pointer on this page moves where you look. A face movement you
        choose (opening the jaw, a clench, a long blink) or simply keeping still makes the click. A small vision model
        finds the face; everything after that is arithmetic done by this page.
      </p>
      <div className="gp-notice small">
        <p>
          <b>What a web page can and cannot do.</b> A page cannot move your computer’s own cursor, so this one moves its
          own pointer over the practice area below. The post that inspired it used AirPods to feel jaw clenches; their
          motion sensors are open only to apps Apple builds for its own systems, not to web pages, so here the camera
          watches for the click instead. A clench barely shows on camera, so the “clench” choice watches for the lips
          pressing together, which goes with it.
        </p>
        <p>
          <b>Privacy.</b> The camera picture never leaves this browser. The face model is downloaded once, then every
          frame is processed on this computer. Nothing is recorded or sent anywhere.
        </p>
      </div>
      {error && <p className="gp-bad small">{error}</p>}

      <div className="gp-bar">
        {!running && (
          <>
            <button className="btn primary" onClick={() => void startCamera()} disabled={source === 'loading'}>
              {source === 'loading' ? 'Starting the camera and the face model…' : 'Start the camera'}
            </button>
            <button className="btn" onClick={startMouse} disabled={source === 'loading'}>
              Try it with the mouse instead
            </button>
          </>
        )}
        {running && (
          <>
            <button className="btn primary" onClick={calibrate} disabled={busy}>
              {session.current.mapping ? 'Calibrate again' : 'Calibrate'}
            </button>
            {stage === 'done' && (
              <button className="btn" onClick={practiseAgain}>
                Practise again
              </button>
            )}
          </>
        )}
        <label className="small">
          Click by{' '}
          <select value={method} onChange={(e) => setMethod(e.target.value as Method)} disabled={busy}>
            {(Object.keys(METHODS) as Method[]).map((k) => (
              <option key={k} value={k}>
                {METHODS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="small gp-steady">
          Steadiness <input type="range" min={1} max={5} value={steady} onChange={(e) => setSteady(+e.target.value)} />
        </label>
      </div>

      <div className="gp-layout">
        <div
          ref={area}
          className={`gp-area${running ? '' : ' off'}`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            session.current.mouse = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
          }}
          onPointerDown={() => {
            if (source === 'mouse') session.current.pressed = true;
          }}
          onPointerUp={() => {
            session.current.pressed = false;
          }}
          onPointerLeave={() => {
            session.current.pressed = false;
          }}
        >
          <div ref={targetDot} className="gp-target" />
          <div ref={rawDot} className="gp-raw" title="Where the gaze points, before steadying" />
          <div ref={smoothDot} className="gp-pointer" />
          <div ref={flash} className="gp-flash" />
          <p className="gp-status">{running ? status : 'Start the camera, or try it with the mouse.'}</p>
          {source === 'mouse' && (
            <p className="gp-help small">
              Mouse demo: the mouse plays your eyes (with a made-up distortion that calibration has to undo), and
              holding the space bar or the mouse button plays your click.
            </p>
          )}
        </div>

        <aside className="gp-side">
          <div className="card">
            <div className="gp-cam">
              <video ref={video} playsInline muted />
              <canvas ref={preview} width={240} height={180} />
              {source !== 'camera' && <span>{source === 'mouse' ? 'Mouse demo: no camera' : 'Camera off'}</span>}
            </div>
            <p className="small muted">
              <i className="gp-key iris" /> irises <i className="gp-key eye" /> eye corners and lids{' '}
              <i className="gp-key nose" /> nose
            </p>
            <div className="small">
              <b>Click signal</b> {method === 'dwell' ? '(dwell timer)' : `(${METHODS[method].label.toLowerCase()})`}
            </div>
            <div className="gp-meter">
              <div ref={meterFill} className="gp-fill" />
              <div ref={meterLine} className="gp-line" />
            </div>
            {note && <p className="gp-bad small">{note}</p>}
            <dl className="gp-facts small">
              <dt>Accuracy</dt>
              <dd>
                {accuracy === null
                  ? 'after calibration'
                  : `${Math.round(accuracy)} px average error (${Math.round((accuracy / (area.current?.clientWidth || 1)) * 100)}% of the width)`}
              </dd>
              <dt>Your click</dt>
              <dd>
                {method === 'dwell'
                  ? 'stay within the target for 1 second'
                  : clickInfo
                    ? `threshold ${clickInfo.threshold.toFixed(2)} (resting up to ${clickInfo.restTop.toFixed(2)}, clicks reach ${clickInfo.peak.toFixed(2)})`
                    : 'set during calibration'}
              </dd>
              {results && (
                <>
                  <dt>Practice</dt>
                  <dd>
                    {results.hits} targets, {results.misses} missed clicks, {(results.meanMs / 1000).toFixed(1)} s each
                    on average
                  </dd>
                </>
              )}
            </dl>
            <p className="small muted">
              <span className="gp-key-dot raw" /> raw gaze · <span className="gp-key-dot smooth" /> steadied pointer
            </p>
          </div>
        </aside>
      </div>

      <h2>How it works</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Find 478 points on the face, 52 expression scores and the head’s rotation, 30 or more times a second
              </td>
              <td>MediaPipe’s FaceLandmarker, a small vision model running in the browser</td>
              <td>Finding a face in a picture is a job for a trained model</td>
            </tr>
            <tr>
              <td>Turn the iris position within each eye, and the head’s yaw and pitch, into four numbers</td>
              <td>Code</td>
              <td>Geometry on the points the model found</td>
            </tr>
            <tr>
              <td>Learn where on the area those four numbers point, from nine dots</td>
              <td>Code: a least-squares fit, one weighted sum per axis</td>
              <td>Every face, camera and seat differs, so each person is calibrated</td>
            </tr>
            <tr>
              <td>Steady the pointer</td>
              <td>Code: the One Euro filter</td>
              <td>Eyes flick constantly; the filter smooths when still and follows quickly when moving</td>
            </tr>
            <tr>
              <td>Decide when a face movement is a click</td>
              <td>Code: a threshold set from your own resting and clicking, a minimum hold, and a release</td>
              <td>An ordinary blink or a passing twitch must not click</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Who uses this kind of tool</h2>
      <p>
        People with limited hand movement, for example after a stroke or with motor neurone disease, use eye tracking
        and face gestures to control a computer. Established options include Apple’s Eye Tracking setting (iPhone and
        iPad, from iOS 18), Windows Eye Control (with a supported eye tracker), Google’s open-source Project Gameface
        (face gestures move a cursor), and dedicated eye-tracking devices supplied for communication aids. Those are
        tested with the people who rely on them. This page is a demonstration of the technique, not an assistive device.
      </p>
      <p className="small muted">
        Accuracy depends heavily on light, glasses, distance and keeping the head still. Webcam gaze tracking is usually
        good to a few centimetres on the screen, so the practice targets are large.
      </p>
    </main>
  );
}
