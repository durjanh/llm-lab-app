import { useEffect, useRef, useState } from 'react';
import { modelName } from '@/lib/models';
import { fitnessService, type CoachReply, type CoachSends } from '@/services/fitnessService';
import { statusService } from '@/services/statusService';
import {
  BONES,
  DEMO_SLIDER,
  EXERCISES,
  assess,
  averagePose,
  compare,
  demoPose,
  normalise,
  toPixels,
  type Assessment,
  type Exercise,
  type Pt,
  type TaughtPose,
} from './form';
import { createPoseModel, type PoseModel } from './pose';
import { CoachVoice } from './voice';
import './fitness-coach.css';

type Source = 'none' | 'loading' | 'camera' | 'demo';

const DEMO_W = 640;
const DEMO_H = 480;
const SMOOTH = 0.45; // how much of each new frame goes into the steadied points
const FAULT_MS = 2500; // a check must fail this long before the coach says anything
const CUE_GAP_MS = 8000; // and then not again for this long
const POSES_KEY = 'fitness-coach.poses';
const TARGETS = [20, 30, 45, 60, 90];

const SENDS: Record<CoachSends, string> = {
  numbers: 'The measurements only (text)',
  photo: 'One photo only',
  both: 'A photo and the measurements',
};

function loadPoses(): TaughtPose[] {
  try {
    const raw = localStorage.getItem(POSES_KEY);
    return raw ? (JSON.parse(raw) as TaughtPose[]) : [];
  } catch {
    return [];
  }
}

function savePoses(poses: TaughtPose[]): void {
  try {
    localStorage.setItem(POSES_KEY, JSON.stringify(poses));
  } catch {
    // Private windows can refuse storage: taught poses then last until the page closes.
  }
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

interface Session {
  model: PoseModel | null;
  stream: MediaStream | null;
  points: Pt[] | null; // steadied, as fractions of the frame
  latest: Assessment | null;
  last: number;
  heldMs: number;
  goodMs: number;
  faultSince: Record<string, number>;
  lastCue: number;
  cuedKey: string;
  said: Set<string>;
  outSince: number;
  capture: [number, number][][] | null;
}

const newSession = (): Session => ({
  model: null,
  stream: null,
  points: null,
  latest: null,
  last: 0,
  heldMs: 0,
  goodMs: 0,
  faultSince: {},
  lastCue: 0,
  cuedKey: '',
  said: new Set(),
  outSince: 0,
  capture: null,
});

interface Snapshot {
  found: boolean;
  a: Assessment | null;
  heldMs: number;
  goodMs: number;
}

interface Asked extends CoachReply {
  question: string;
  photo: string;
}

/** A fitness coach: a pose model finds the body, code checks the form, and a model says what to fix. */
export default function FitnessCoachPage() {
  const [source, setSource] = useState<Source>('none');
  const [exercise, setExercise] = useState<Exercise>('plank');
  const [target, setTarget] = useState(30);
  const [amount, setAmount] = useState(0);
  const [models, setModels] = useState<string[]>([]);
  const [claudeModels, setClaudeModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [send, setSend] = useState<CoachSends>('numbers');
  const [cues, setCues] = useState(true);
  const [ears, setEars] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState<Snapshot>({ found: false, a: null, heldMs: 0, goodMs: 0 });
  const [asked, setAsked] = useState<Asked[]>([]);
  const [poses, setPoses] = useState<TaughtPose[]>(loadPoses);
  const [poseIdx, setPoseIdx] = useState(0);
  const [poseName, setPoseName] = useState('');
  const [teaching, setTeaching] = useState('');

  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const session = useRef<Session>(newSession());
  const voice = useRef<CoachVoice | null>(null);
  const mounted = useRef(true);
  const timers = useRef<number[]>([]);
  const askRef = useRef<(question?: string) => void>(() => undefined);

  const pose = exercise === 'custom' ? (poses[poseIdx] ?? null) : null;
  // What the frame loop reads: it runs outside React, so it sees the latest choices through this.
  const opts = useRef({ exercise, amount, pose, cues, target, busy });
  opts.current = { exercise, amount, pose, cues, target, busy };

  voice.current ??= new CoachVoice();

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setClaudeModels(s.claude_models || s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => setError('The backend is not answering, so the coach cannot speak. The form checks still work.'));
  }, []);

  // A photo needs a model that can see: Claude. The measurements suit any model.
  const offered = send === 'numbers' ? models : claudeModels;
  useEffect(() => {
    if (offered.length && !offered.includes(model)) setModel(offered[0]);
  }, [offered, model]);

  // Everything is let go when the page closes. Marked open again on every mount: React's development mode runs this
  // cleanup once at the start, and a camera that finished starting would otherwise be shut at once.
  useEffect(() => {
    mounted.current = true;
    const v = voice.current!;
    v.onError = (m) => {
      setError(m);
      setEars(false);
    };
    v.onHeard = (t) => setHeard(t);
    v.onAsk = (q) => askRef.current(q);
    return () => {
      mounted.current = false;
      const s = session.current;
      s.stream?.getTracks().forEach((t) => t.stop());
      s.model?.close();
      s.stream = null;
      s.model = null;
      v.stopListening();
      v.stopSpeaking();
      timers.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const resetHold = () => {
    const s = session.current;
    s.heldMs = 0;
    s.goodMs = 0;
    s.faultSince = {};
    s.said = new Set();
    s.cuedKey = '';
  };
  useEffect(resetHold, [exercise, poseIdx, target]);

  const say = (text: string) => void voice.current?.say(text);

  // The frame loop: find the body, steady the points, check the form, time the hold, speak cues, draw.
  useEffect(() => {
    if (source !== 'camera' && source !== 'demo') return;
    let frame = 0;
    let lastSnap = 0;
    const s = session.current;
    s.last = 0;

    const draw = (points: Pt[] | null, a: Assessment | null, w: number, h: number) => {
      const c = canvas.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.save();
      if (source === 'camera') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1); // a mirror, as people expect to see themselves
        if (video.current) ctx.drawImage(video.current, 0, 0, w, h);
      } else {
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, 412);
        ctx.lineTo(w, 412);
        if (opts.current.exercise === 'wall-sit' && points) {
          const wall = Math.min(points[23].x, points[11].x) * w - 16; // the wall just behind the back
          ctx.moveTo(wall, 0);
          ctx.lineTo(wall, 412);
        }
        ctx.stroke();
      }
      if (points) {
        const bad = new Set(a?.checks.filter((k) => !k.ok).flatMap((k) => k.joints) ?? []);
        const px = (p: Pt) => [p.x * w, p.y * h] as const;
        ctx.lineWidth = Math.max(3, w / 220);
        ctx.lineCap = 'round';
        for (const [i, j] of BONES) {
          if (points[i].v < 0.3 || points[j].v < 0.3) continue;
          ctx.strokeStyle = bad.has(i) && bad.has(j) ? '#f87171' : 'rgba(56, 189, 248, 0.9)';
          ctx.beginPath();
          ctx.moveTo(...px(points[i]));
          ctx.lineTo(...px(points[j]));
          ctx.stroke();
        }
        for (let i = 11; i < 33; i++) {
          if (points[i].v < 0.3 || (i > 16 && i < 23)) continue;
          ctx.fillStyle = bad.has(i) ? '#ef4444' : '#facc15';
          ctx.beginPath();
          ctx.arc(...px(points[i]), Math.max(4, w / 160), 0, Math.PI * 2);
          ctx.fill();
        }
        if (source === 'demo') {
          // The drawn figure's head, between the ear and the nose (the camera shows a real one).
          const [ex, ey] = px(points[7]);
          const [nx, ny] = px(points[0]);
          const [sx, sy] = px(points[11]);
          ctx.strokeStyle = bad.has(7) ? '#f87171' : 'rgba(56, 189, 248, 0.9)';
          ctx.beginPath();
          ctx.arc((ex + nx) / 2, (ey + ny) / 2, Math.hypot(ex - sx, ey - sy) * 0.45, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    const cue = (t: number, a: Assessment | null) => {
      const o = opts.current;
      const v = voice.current!;
      if (!o.cues || o.busy || v.speaking) return;
      const targetMs = o.target * 1000;
      if (a?.inPosition) {
        if (s.heldMs >= targetMs && !s.said.has('done')) {
          s.said.add('done');
          s.lastCue = t;
          return say(`That's ${o.target} seconds. Well done. Rest now.`);
        }
        if (s.heldMs >= targetMs - 10_000 && targetMs > 15_000 && !s.said.has('ten')) {
          s.said.add('ten');
          s.lastCue = t;
          return say('Ten seconds to go. Keep it up.');
        }
        if (s.heldMs >= targetMs / 2 && targetMs >= 30_000 && !s.said.has('half')) {
          s.said.add('half');
          s.lastCue = t;
          return say('Halfway.');
        }
        const failing = a.checks.find((k) => !k.ok && k.cue && t - (s.faultSince[k.key] ?? t) > FAULT_MS);
        if (failing && t - s.lastCue > CUE_GAP_MS) {
          s.lastCue = t;
          s.cuedKey = failing.key;
          return say(failing.cue);
        }
        const fixed = s.cuedKey && a.checks.find((k) => k.key === s.cuedKey)?.ok;
        if (fixed && t - s.lastCue > 1500) {
          s.cuedKey = '';
          s.lastCue = t;
          return say("That's it.");
        }
      } else if (a && s.outSince && t - s.outSince > 6000 && t - s.lastCue > 15_000) {
        s.lastCue = t;
        return say(a.hint);
      }
    };

    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      const o = opts.current;
      const dt = s.last ? Math.min(t - s.last, 100) : 0;
      s.last = t;
      let raw: Pt[] | null = null;
      let w = DEMO_W;
      let h = DEMO_H;
      if (source === 'camera') {
        const v = video.current;
        if (!v || !s.model) return;
        w = v.videoWidth || DEMO_W;
        h = v.videoHeight || DEMO_H;
        try {
          raw = s.model.detect(v, t);
        } catch (err) {
          stopCamera();
          setError(
            `The pose model stopped: ${err instanceof Error ? err.message : String(err)}. Try the drawn figure.`,
          );
          return;
        }
      } else {
        const figure = o.exercise === 'custom' ? 'lunge' : o.exercise;
        raw = demoPose(figure, o.amount, t).map((p) => ({ x: p.x / DEMO_W, y: p.y / DEMO_H, v: p.v }));
      }
      // Steadying: each point moves part of the way to where the model now puts it.
      if (raw) {
        const prev = s.points;
        s.points = prev
          ? raw.map((p, i) => ({
              x: prev[i].x + SMOOTH * (p.x - prev[i].x),
              y: prev[i].y + SMOOTH * (p.y - prev[i].y),
              v: p.v,
            }))
          : raw;
      } else {
        s.points = null;
      }
      const px = s.points ? toPixels(s.points, w, h) : null;
      let a: Assessment | null = null;
      if (px) {
        if (o.exercise !== 'custom') a = assess(o.exercise, px, w, h);
        else if (o.pose) a = compare(o.pose, px);
        if (s.capture) {
          const n = normalise(px);
          if (n) s.capture.push(n);
        }
      }
      s.latest = a;
      if (a?.inPosition) {
        s.outSince = 0;
        s.heldMs += dt;
        if (a.checks.every((k) => k.ok)) s.goodMs += dt;
        for (const k of a.checks) {
          if (k.ok) delete s.faultSince[k.key];
          else s.faultSince[k.key] ??= t;
        }
      } else {
        s.faultSince = {};
        if (px && !s.outSince) s.outSince = t;
        if (!px) s.outSince = 0;
      }
      cue(t, a);
      draw(s.points, a, w, h);
      if (t - lastSnap > 200) {
        lastSnap = t;
        setSnap({ found: !!px, a, heldMs: s.heldMs, goodMs: s.goodMs });
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // The space bar asks, for anyone who would rather not talk (a hand is free in a wall sit).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, select, textarea, button')) return;
      e.preventDefault();
      askRef.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  async function startCamera() {
    setError('');
    voice.current!.unlock();
    setSource('loading');
    const s = session.current;
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      const v = video.current!;
      v.srcObject = s.stream;
      await v.play();
      s.model ??= await createPoseModel();
      if (!mounted.current) return;
      s.points = null;
      resetHold();
      setSource('camera');
    } catch (err) {
      s.stream?.getTracks().forEach((t) => t.stop());
      s.stream = null;
      const name = err instanceof Error ? err.name : '';
      setError(
        name === 'NotAllowedError'
          ? 'The browser refused the camera. Allow it in the address bar, or try the drawn figure.'
          : `The camera or the pose model could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      setSource('none');
    }
  }

  function stopCamera() {
    const s = session.current;
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
    s.points = null;
    setSource('none');
  }

  function startDemo() {
    setError('');
    voice.current!.unlock();
    stopCamera();
    session.current.points = null;
    resetHold();
    setSource('demo');
  }

  function toggleEars() {
    const v = voice.current!;
    v.unlock();
    if (ears) {
      v.stopListening();
      setHeard('');
    } else {
      v.listen();
    }
    setEars(!ears);
  }

  /** One frame as a small JPEG: the camera picture itself (not the mirrored drawing), or the drawn figure. */
  function photo(): string {
    const src: HTMLVideoElement | HTMLCanvasElement | null = source === 'camera' ? video.current : canvas.current;
    if (!src) return '';
    const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
    const h = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
    if (!w || !h) return '';
    const out = document.createElement('canvas');
    out.width = 512;
    out.height = Math.round((512 * h) / w);
    out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.7);
  }

  async function ask(question = '') {
    if (opts.current.busy || !model) return;
    if (source !== 'camera' && source !== 'demo') {
      setError('Start the camera or the drawn figure first, so the coach has something to go on.');
      return;
    }
    const v = voice.current!;
    v.unlock();
    v.pause();
    opts.current.busy = true;
    setBusy(true);
    setError('');
    const s = session.current;
    const a = s.latest;
    const shot = send === 'numbers' ? '' : photo();
    try {
      const r = await fitnessService.coach({
        model,
        exercise,
        exercise_label: exercise === 'custom' && pose ? `Your own pose, “${pose.name}”` : EXERCISES[exercise].label,
        send,
        question,
        view: a?.view ?? 'unknown',
        in_position: !!a?.inPosition,
        hold_seconds: Math.round(s.heldMs / 1000),
        target_seconds: target,
        similarity: a?.similarity ?? null,
        measures: (a?.measures ?? []).map(({ label, value, unit, ideal }) => ({ label, value, unit, ideal })),
        checks: (a?.checks ?? []).map(({ label, ok, detail }) => ({ label, ok, detail })),
        photo: shot,
      });
      if (!mounted.current) return;
      setAsked((list) =>
        [{ ...r, question: question || "How's my form?", photo: r.photo_sent ? shot : '' }, ...list].slice(0, 6),
      );
      await v.say(r.reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      opts.current.busy = false;
      setBusy(false);
      v.resume();
    }
  }
  askRef.current = (q?: string) => void ask(q);

  function teach() {
    const name = poseName.trim() || `Pose ${poses.length + 1}`;
    const s = session.current;
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    voice.current!.unlock();
    setTeaching('Get into the pose…');
    say('Get into the pose. Three, two, one, hold.');
    later(3500, () => {
      setTeaching('Hold still…');
      s.capture = [];
    });
    later(5000, () => {
      const frames = s.capture ?? [];
      s.capture = null;
      if (frames.length < 5) {
        setTeaching('');
        setError(
          'The camera could not see your shoulders and hips well enough to learn the pose. Step back and try again.',
        );
        return;
      }
      const taught = { name, points: averagePose(frames) };
      const next = [...poses.filter((p) => p.name !== name), taught].slice(-6);
      setPoses(next);
      savePoses(next);
      setPoseIdx(next.length - 1);
      setPoseName('');
      setTeaching('');
      say(`Got it. ${name} is saved.`);
    });
  }

  function forget(i: number) {
    const next = poses.filter((_, k) => k !== i);
    setPoses(next);
    savePoses(next);
    setPoseIdx(0);
  }

  const running = source === 'camera' || source === 'demo';
  const a = snap.a;
  const targetMs = target * 1000;
  const latest = asked[0];
  const spent = asked.reduce((sum, r) => sum + r.cost_usd, 0);
  const slider = DEMO_SLIDER[exercise === 'custom' ? 'lunge' : exercise];

  return (
    <main className="page-fitness-coach">
      <div className="kicker">Building · Fitness coach</div>
      <h1>A coach that watches your form</h1>
      <p className="lede">
        Hold a plank, a wall sit or a lunge stretch in front of the camera and ask “How’s my form?”. A small vision
        model finds 33 points on your body, this page measures the angles between them and checks them against simple
        rules, and a language model turns the result into a sentence a coach would say aloud.
      </p>
      <div className="fc-notice small">
        <p>
          <b>What goes where.</b> The camera picture stays in this browser: the pose model is downloaded once and every
          frame is processed on this computer. When you ask, the model normally gets only the numbers shown on the panel
          (you can see exactly what under the answer). Sending a photo instead is a choice below, so you can compare.
        </p>
        <p>
          <b>Safety.</b> This is a demonstration of the technique, not a trainer or medical advice. Stop if anything
          hurts. The angles are estimates from a webcam and can be several degrees out.
        </p>
      </div>
      {error && <p className="fc-bad small">{error}</p>}

      <div className="fc-bar">
        {source === 'camera' ? (
          <button className="btn" onClick={stopCamera}>
            Stop the camera
          </button>
        ) : (
          <button className="btn primary" onClick={() => void startCamera()} disabled={source === 'loading'}>
            {source === 'loading' ? 'Starting the camera and the pose model…' : 'Start the camera'}
          </button>
        )}
        {source !== 'demo' && (
          <button className="btn" onClick={startDemo} disabled={source === 'loading'}>
            Try it with a drawn figure
          </button>
        )}
        <label className="small">
          Exercise{' '}
          <select value={exercise} onChange={(e) => setExercise(e.target.value as Exercise)}>
            {(Object.keys(EXERCISES) as Exercise[]).map((k) => (
              <option key={k} value={k}>
                {EXERCISES[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Hold for{' '}
          <select value={target} onChange={(e) => setTarget(+e.target.value)}>
            {TARGETS.map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={resetHold} disabled={!running}>
          Restart the timer
        </button>
      </div>
      <p className="small muted fc-setup">{EXERCISES[exercise].setup}</p>

      {exercise === 'custom' && (
        <div className="fc-teach card small">
          <b>Teach a pose.</b> Name it, press the button, get into the pose during the count, and hold still for a
          second and a half. The page keeps up to six, in this browser only.
          <div className="fc-row">
            <input
              value={poseName}
              onChange={(e) => setPoseName(e.target.value)}
              placeholder="Name, e.g. Arms out"
              maxLength={30}
            />
            <button className="btn" onClick={teach} disabled={!running || !!teaching}>
              {teaching || 'Teach this pose'}
            </button>
          </div>
          {poses.length > 0 && (
            <div className="fc-poses">
              {poses.map((p, i) => (
                <span key={p.name} className={`fc-pose${i === poseIdx ? ' on' : ''}`}>
                  <button className="fc-link" onClick={() => setPoseIdx(i)}>
                    {p.name}
                  </button>
                  <button className="fc-x" onClick={() => forget(i)} title={`Forget ${p.name}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {source === 'demo' && (
            <p className="muted">With the drawn figure: teach it at one slider position, then move the slider.</p>
          )}
        </div>
      )}

      <div className="fc-layout">
        <div className="fc-stage-wrap">
          <div className={`fc-stage${running ? '' : ' off'}`}>
            <video ref={video} playsInline muted />
            <canvas ref={canvas} width={DEMO_W} height={DEMO_H} />
            {!running && <p className="fc-overlay">Start the camera, or try it with a drawn figure.</p>}
            {running && a && !a.inPosition && <p className="fc-overlay bottom">{a.hint}</p>}
            {running && source === 'camera' && !snap.found && (
              <p className="fc-overlay bottom">Nobody in view: step back until your whole body is in the picture.</p>
            )}
            {running && exercise === 'custom' && !pose && (
              <p className="fc-overlay bottom">Teach a pose first, above.</p>
            )}
          </div>
          {source === 'demo' && (
            <label className="fc-slider small">
              {slider.label}: <span className="muted">{slider.low}</span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={amount}
                onChange={(e) => setAmount(+e.target.value)}
              />
              <span className="muted">{slider.high}</span>
            </label>
          )}
        </div>

        <aside className="fc-panel card">
          <div className="fc-panel-head">
            <b>{exercise === 'custom' && pose ? pose.name : EXERCISES[exercise].label}</b>
            {a && (
              <span className={`fc-view ${a.view}`}>
                {a.view === 'side' ? 'side-on' : a.view === 'front' ? 'front-on' : '…'}
              </span>
            )}
          </div>
          <div className="fc-timer">
            {clock(snap.heldMs)} <span className="muted">/ {clock(targetMs)}</span>
          </div>
          <div className="fc-progress">
            <div style={{ width: `${Math.min(100, (snap.heldMs / targetMs) * 100)}%` }} />
          </div>
          <p className="small muted fc-good">
            {snap.heldMs > 1000
              ? `Good form for ${Math.round((snap.goodMs / snap.heldMs) * 100)}% of the hold`
              : 'The timer runs while you are in position'}
          </p>
          {a?.similarity !== undefined && (
            <div className="fc-sim small">
              Similarity <b>{a.similarity.toFixed(2)}</b>
              <div className="fc-progress sim">
                <div style={{ width: `${a.similarity * 100}%` }} className={a.similarity >= 0.8 ? 'ok' : ''} />
              </div>
            </div>
          )}
          <ul className="fc-checks small">
            {(a?.checks ?? []).map((k) => (
              <li key={k.key} className={k.ok ? 'ok' : 'bad'}>
                <span className="fc-mark">{k.ok ? '✓' : '!'}</span>
                <span>
                  {k.label}
                  {k.detail && <span className="muted"> · {k.detail}</span>}
                </span>
              </li>
            ))}
            {!a && <li className="muted">The checks appear once a body is found.</li>}
          </ul>
          {a && a.measures.length > 0 && (
            <table className="fc-measures small">
              <tbody>
                {a.measures.map((m) => (
                  <tr key={m.key} className={m.ok ? '' : 'bad'}>
                    <td>{m.label}</td>
                    <td className="num">
                      {m.value}
                      {m.unit === '°' ? '°' : ''}
                    </td>
                    <td className="muted">{m.ideal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </aside>
      </div>

      <section className="fc-coach card">
        <div className="fc-bar">
          <button className="btn primary" onClick={() => void ask()} disabled={busy || !model || !running}>
            {busy ? 'The coach is thinking…' : 'Ask: “How’s my form?”'}
          </button>
          <span className="small muted">or press the space bar</span>
          <button className={`btn${ears ? ' primary' : ''}`} onClick={toggleEars}>
            {ears ? 'Listening for “How’s my form?”' : 'Ask out loud'}
          </button>
          <label className="small">
            <input type="checkbox" checked={cues} onChange={(e) => setCues(e.target.checked)} /> Spoken cues
          </label>
        </div>
        <div className="fc-bar">
          <label className="small">
            The coach gets{' '}
            <select value={send} onChange={(e) => setSend(e.target.value as CoachSends)} disabled={busy}>
              {(Object.keys(SENDS) as CoachSends[]).map((k) => (
                <option key={k} value={k}>
                  {SENDS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            Model{' '}
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {offered.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {spent > 0 && <span className="small muted">Spent on this page: ${spent.toFixed(4)}</span>}
        </div>
        {ears && <p className="small muted fc-heard">Heard: {heard || '…'}</p>}

        {latest ? (
          <>
            <p className="fc-reply">“{latest.reply}”</p>
            <p className="small muted">
              {modelName(latest.model)} ({latest.model}) in {latest.seconds.toFixed(1)} s
              {latest.input_tokens ? `, ${latest.input_tokens} tokens in` : ''}, ${latest.cost_usd.toFixed(5)}. You
              asked: “{latest.question}”.
            </p>
            <details className="fc-sent" open>
              <summary className="small">What the coach got</summary>
              <div className="fc-sent-body">
                {latest.photo && <img src={latest.photo} alt="The frame sent to the model" />}
                <pre>{latest.sent}</pre>
              </div>
            </details>
            {asked.length > 1 && (
              <details className="small">
                <summary>Earlier answers</summary>
                <ul className="fc-earlier">
                  {asked.slice(1).map((r, i) => (
                    <li key={i}>
                      “{r.reply}”{' '}
                      <span className="muted">
                        ({r.photo_sent ? 'with a photo' : 'numbers only'}, {r.seconds.toFixed(1)} s, $
                        {r.cost_usd.toFixed(5)})
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <p className="small muted">
            The answer appears here and is spoken. Try asking the same question with the numbers and then with a photo:
            the numbers are quicker and cheaper, and the model cannot invent what it was not given.
          </p>
        )}
      </section>

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
              <td>Find 33 points on the body (shoulders, hips, knees, ankles and so on), 20 to 30 times a second</td>
              <td>MediaPipe’s pose landmarker, a small vision model running in the browser</td>
              <td>Finding a body in a picture is a job for a trained model</td>
            </tr>
            <tr>
              <td>Steady the points, pick the side nearer the camera, and tell side-on from front-on</td>
              <td>Code</td>
              <td>From the side the two shoulders nearly overlap; from the front they are a torso’s length apart</td>
            </tr>
            <tr>
              <td>Measure the angles: shoulder, hip and ankle for a plank; hip, knee and ankle for a wall sit</td>
              <td>Code: geometry on the points</td>
              <td>An angle is exact arithmetic; there is nothing to guess</td>
            </tr>
            <tr>
              <td>Decide what is wrong (“hips sagging by 14°”) and time the hold</td>
              <td>Code: a few rules per exercise</td>
              <td>
                The rules are what a coach checks. Written as code, they are cheap, instant and the same every time
              </td>
            </tr>
            <tr>
              <td>Short spoken cues while you hold (“Lift your hips a little”, “Ten seconds to go”)</td>
              <td>Code: fixed sentences, after a fault has lasted 2.5 seconds</td>
              <td>A cue every frame would nag. Fixed wording needs no model, so it costs nothing</td>
            </tr>
            <tr>
              <td>Answer “How’s my form?” in a sentence or two</td>
              <td>A language model, given the measurements as text</td>
              <td>
                Choosing the most useful correction and saying it kindly, and answering whatever was asked, is language
                work
              </td>
            </tr>
            <tr>
              <td>Speak, and listen for the question</td>
              <td>Azure Speech, or the browser’s own speech when Azure Speech is not set up</td>
              <td>Your hands are on the floor</td>
            </tr>
            <tr>
              <td>Learn your own pose and score how close you are</td>
              <td>
                Code: 13 points moved to the hips and scaled by the torso, then a bell curve on each point’s distance
              </td>
              <td>Where you stand and how far from the camera you are should not change the score</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Numbers or a photo</h2>
      <p>
        The page can send the model the measurements, a photo, or both. With the numbers, the model cannot see you, but
        it knows exactly how far the hips are out, and it answers in about a second for a fraction of a penny. With only
        a photo, the model has to judge the angles by eye from a small image. It is slower, costs more (an image is
        several hundred tokens), sends a picture of you to the provider, and can sound sure about angles it cannot
        measure. Sending both lets it check the numbers against the picture, for example to spot that the camera is at a
        bad angle.
      </p>
      <p>
        This split is the general pattern for putting a language model on top of a sensor: let measurement code turn the
        signal into a few trustworthy numbers, and give the model those numbers to explain, not the raw signal to
        interpret.
      </p>

      <h2>The build that inspired it</h2>
      <p>
        The idea comes from a do-it-yourself fitness assistant built from three parts: a camera module that runs a pose
        model on its own chip, a small screen, and a voice assistant. Each part has a counterpart on this page.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>In the build</th>
              <th>On this page</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A pose sensor reporting 17 points and a similarity score for poses it has been taught</td>
              <td>MediaPipe’s 33 points in the browser, and “Your own pose” for teaching and matching</td>
            </tr>
            <tr>
              <td>A small screen showing the exercise, the similarity and ticks or warnings</td>
              <td>The panel beside the video</td>
            </tr>
            <tr>
              <td>A voice assistant that answers “How’s my form?”</td>
              <td>Azure Speech or the browser for listening and speaking, and a language model for the answer</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Webcam angles are estimates. Loose clothing, poor light, a camera tilted up or down, and part of the body out of
        frame all move the points. A camera at hip height, side-on and two to three metres away gives the steadiest
        readings.
      </p>
    </main>
  );
}
